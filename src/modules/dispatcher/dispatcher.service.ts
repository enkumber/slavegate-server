/**
 * modules/dispatcher/dispatcher.service.ts
 * Job queuing via BullMQ — per-device queues, retry, timeout handling.
 *
 * Security: only whitelisted JobTypes are accepted.
 * All dispatched jobs are audit-logged.
 */

import { Queue } from "bullmq";
import { getRedisConnectionOptions } from "../../redis/client";
import { getDb } from "../../db/client";
import { getResourceLifecycleExecutionStatusContract } from "../lifecycle/lifecycle.service";
import { isKillSwitchActive } from "../../api/routes";
import { deviceExecutionArbiter } from "../device-execution";
import { isDeviceExecutionEnforced } from "../device-execution/device-execution-authority";
import { pnqV2RuntimeService, runPnqV2ShadowSideEffect } from "../device-execution/pnq-v2-runtime.service";
import { isPnqV2ShadowRuntimeEnabled } from "../device-execution/pnq-v2-runtime-config";
// NOTE: wsServer is intentionally NOT imported here — would create circular dependency.
// Job dispatch to device WebSocket is handled by routes.ts (after calling dispatcher.dispatch()).
// dispatcher only manages the DB + queue layer.
import type { JobType, JobParams, JobDispatchPayload } from "../../../shared/protocol/messages";
import type { Job, DispatchJobRequest } from "../../../shared/protocol/api-types";
import { v4 as uuidv4 } from "uuid";
import { recordJobExecutionEventDetached } from "../observability/job-execution-events";
import {
  expireStaleJobs,
  transitionJob,
  transitionJobByConfiguredStalePolicy,
} from "./job-lifecycle.service";
import { getCanonicalWorkflowPredicateMetadataPolicy } from "../runtime-policy/resource-runtime-policy.service";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

interface JobActionPolicy {
  allowed: boolean;
  requiresRoot: boolean;
  nativeOpcode: number;
  observationOnly: boolean;
  verificationOpcode: number;
  timeoutPerUnitMs: number | null;
  timeoutBaseMs: number;
  timeoutInputPath: string | null;
  executionPolicy: Record<string, unknown>;
  parameterTransforms: unknown[];
  defaultParams: Record<string, unknown>;
}

function readPolicyPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertJobActionResultPolicy(
  result: unknown,
  policy: Record<string, unknown>,
  context: string,
): void {
  const assertions = Array.isArray(policy.resultAssertions) ? policy.resultAssertions : [];
  for (const raw of assertions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const assertion = raw as Record<string, unknown>;
    const path = typeof assertion.path === "string" ? assertion.path : "";
    if (!path) continue;
    const actual = readPolicyPath(result, path);
    const passed = Object.prototype.hasOwnProperty.call(assertion, "equals")
      ? actual === assertion.equals
      : assertion.exists === true
        ? actual !== undefined
        : assertion.exists === false
          ? actual === undefined
          : false;
    if (!passed) {
      throw new Error(typeof assertion.error === "string"
        ? assertion.error
        : `${context} result policy failed at '${path}'`);
    }
  }
}

export interface JobActionPolicyDefinition extends JobActionPolicy {
  actionKey: string;
  label: string;
  defaultParams: Record<string, unknown>;
}

export async function listJobActionPolicyDefinitions(): Promise<JobActionPolicyDefinition[]> {
  const result = await getDb().query<{ policy: Record<string, unknown> }>(
    `SELECT entry.payload->'jobActionPolicy' AS policy
       FROM runtime_semantic_entries entry
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE definition.dispatchable
        AND entry.payload ? 'jobActionPolicy'
      ORDER BY entry.priority DESC, entry.id`,
  );
  return result.rows.flatMap(({ policy }) => {
    const actionKey = typeof policy.actionKey === "string" ? policy.actionKey.trim() : "";
    if (
      !actionKey
      || typeof policy.allowed !== "boolean"
      || typeof policy.requiresRoot !== "boolean"
      || !Number.isSafeInteger(policy.nativeOpcode)
      || Number(policy.nativeOpcode) < 0
      || !Number.isSafeInteger(policy.verificationOpcode)
      || Number(policy.verificationOpcode) < 0
    ) {
      return [];
    }
    const defaultParams = policy.defaultParams;
    return [{
      actionKey,
      allowed: policy.allowed,
      requiresRoot: policy.requiresRoot,
      nativeOpcode: Number(policy.nativeOpcode),
      observationOnly: policy.observationOnly === true,
      verificationOpcode: Number(policy.verificationOpcode),
      timeoutPerUnitMs: typeof policy.timeoutPerUnitMs === "number" && policy.timeoutPerUnitMs >= 0
        ? policy.timeoutPerUnitMs
        : null,
      timeoutBaseMs: typeof policy.timeoutBaseMs === "number" && policy.timeoutBaseMs >= 0
        ? policy.timeoutBaseMs
        : 0,
      timeoutInputPath: typeof policy.timeoutInputPath === "string" && policy.timeoutInputPath.trim()
        ? policy.timeoutInputPath.trim()
        : null,
      executionPolicy: policy.executionPolicy && typeof policy.executionPolicy === "object" && !Array.isArray(policy.executionPolicy)
        ? policy.executionPolicy as Record<string, unknown>
        : {},
      parameterTransforms: Array.isArray(policy.parameterTransforms) ? policy.parameterTransforms : [],
      label: typeof policy.label === "string" && policy.label.trim()
        ? policy.label.trim()
        : actionKey,
      defaultParams: defaultParams && typeof defaultParams === "object" && !Array.isArray(defaultParams)
        ? defaultParams as Record<string, unknown>
        : {},
    }];
  });
}

export async function getWorkflowInterpreterPolicy(): Promise<Record<string, unknown>> {
  const result = await getDb().query<{ policy: Record<string, unknown> }>(
    `SELECT entry.payload->'workflowInterpreterPolicy' AS policy
       FROM runtime_semantic_entries entry
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE definition.dispatchable
        AND entry.payload ? 'workflowInterpreterPolicy'
      ORDER BY entry.priority DESC, entry.id`,
  );
  if (result.rows.length !== 1) {
    throw new Error("PostgreSQL workflow interpreter policy is missing or ambiguous");
  }
  const policy = result.rows[0].policy;
  if (policy.predicateMetadata !== undefined) {
    throw new Error("PostgreSQL workflow interpreter predicate metadata must be configured in resource_runtime_policies only");
  }
  return policy;
}

/**
 * Materialize the current PostgreSQL action ABI into an edge-workflow payload.
 * Product action names remain data; Android receives only the numeric primitive
 * slot and structural observation flag needed to execute them.
 */
export async function hydrateWorkflowNativePolicies<T extends Record<string, unknown>>(template: T): Promise<T> {
  const definitions = await listJobActionPolicyDefinitions();
  const executionStates = await getResourceLifecycleExecutionStatusContract("workflows");
  const jobExecutionStates = await getResourceLifecycleExecutionStatusContract("jobs");
  const interpreterPolicy = await getWorkflowInterpreterPolicy();
  const canonicalPredicatePolicy = await getCanonicalWorkflowPredicateMetadataPolicy();
  const runtimeDefaults = interpreterPolicy.runtimeDefaults;
  if (!runtimeDefaults || typeof runtimeDefaults !== "object" || Array.isArray(runtimeDefaults)) {
    throw new Error("PostgreSQL workflow interpreter runtimeDefaults are missing");
  }
  const runtimeDefault = (key: string): unknown => {
    if (!Object.prototype.hasOwnProperty.call(runtimeDefaults, key)) {
      throw new Error(`PostgreSQL workflow interpreter runtime default is missing for '${key}'`);
    }
    return (runtimeDefaults as Record<string, unknown>)[key];
  };
  if (
    !interpreterPolicy.enginePolicy
    || typeof interpreterPolicy.enginePolicy !== "object"
    || Array.isArray(interpreterPolicy.enginePolicy)
  ) {
    throw new Error("PostgreSQL workflow interpreter enginePolicy is missing");
  }
  const opcodeFrom = (catalogKey: string, value: unknown): number => {
    const catalog = interpreterPolicy[catalogKey];
    const opcode = typeof value === "string"
      && catalog
      && typeof catalog === "object"
      && !Array.isArray(catalog)
      ? (catalog as Record<string, unknown>)[value]
      : undefined;
    if (!Number.isSafeInteger(opcode) || Number(opcode) < 0) {
      throw new Error(`PostgreSQL workflow interpreter opcode is missing for ${catalogKey}.${String(value)}`);
    }
    return Number(opcode);
  };
  const policies = new Map(definitions.map((definition) => [definition.actionKey, definition]));
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const hydrated = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, visit(item)]));
    if (typeof source.distribution === "string") {
      hydrated.distributionOpcode = opcodeFrom("distributionOpcodes", source.distribution);
    }
    if (typeof source.check === "string") {
      hydrated.checkOpcode = opcodeFrom("conditionOpcodes", source.check);
      hydrated.probability = source.probability ?? runtimeDefault("conditionProbability");
    }
    if (typeof source.operator === "string") {
      hydrated.operatorOpcode = opcodeFrom("predicateOpcodes", source.operator);
      const metadata = canonicalPredicatePolicy.predicateMetadata[source.operator];
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error(`PostgreSQL canonical operand policy is missing for predicateMetadata.${source.operator}`);
      }
      const operandPolicy = metadata as Record<string, unknown>;
      const operand = operandPolicy.operand;
      if (
        !operand
        || typeof operand !== "object"
        || Array.isArray(operand)
        || typeof (operand as Record<string, unknown>).required !== "boolean"
        || typeof (operand as Record<string, unknown>).type !== "string"
        || !Number.isSafeInteger((operand as Record<string, unknown>).minLength)
        || Number((operand as Record<string, unknown>).minLength) < 0
      ) {
        throw new Error(`PostgreSQL canonical operand policy is incomplete for predicateMetadata.${source.operator}`);
      }
      hydrated.operandContract = { ...(operand as Record<string, unknown>) };
      hydrated.operandContractMetadataSource = canonicalPredicatePolicy.resourceTable;
      hydrated.operandContractMetadataVersion = canonicalPredicatePolicy.version;
    }
    if (typeof source.regex === "string") {
      hydrated.group = source.group ?? runtimeDefault("regexGroup");
    }
    if (source.type === "condition") {
      hydrated.then = Array.isArray(source.then) ? visit(source.then) : visit(source.if_true);
      hydrated.else = Array.isArray(source.else) ? visit(source.else) : visit(source.if_false ?? []);
    }
    if (source.type === "checkpoint" && typeof source.phase !== "string") {
      hydrated.phase = typeof source.reason === "string" && source.reason.trim()
        ? source.reason.trim()
        : source.id;
    }

    const actionKey = typeof source.action === "string" ? source.action.trim() : "";
    const actionShaped = source.type === "action"
      || source.primitive === true
      || Object.prototype.hasOwnProperty.call(source, "outputPath")
      || Object.prototype.hasOwnProperty.call(source, "postcondition")
      || Object.prototype.hasOwnProperty.call(source, "timeoutMs")
      || (
        Object.prototype.hasOwnProperty.call(source, "params")
        && Object.prototype.hasOwnProperty.call(source, "timeoutMs")
      );
    if (!actionKey || !actionShaped) return hydrated;
    hydrated.params = isPlainRecord(source.params) ? hydrated.params : {};
    const policy = policies.get(actionKey);
    if (!policy) throw new Error(`PostgreSQL job action policy is missing for edge action '${actionKey}'`);
    if (!policy.allowed) throw new Error(`PostgreSQL job action policy blocks edge action '${actionKey}'`);
    const executionPolicy = policy.executionPolicy ?? {};
    const executionString = (key: string): string => {
      const value = typeof source[key] === "string" && String(source[key]).trim()
        ? source[key]
        : executionPolicy[key];
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`PostgreSQL job action execution policy is missing '${key}' for edge action '${actionKey}'`);
      }
      return value.trim();
    };
    const executionNumber = (key: string): number => {
      const value = typeof source[key] === "number" ? source[key] : executionPolicy[key];
      if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`PostgreSQL job action execution policy is missing '${key}' for edge action '${actionKey}'`);
      }
      return Number(value);
    };
    const failureMode = typeof source.failureMode === "string" ? source.failureMode.trim() : "";
    const verificationMode = typeof source.verification === "string" && source.verification.trim()
      ? source.verification.trim()
      : interpreterPolicy.defaultVerificationMode;
    const mergedParams = visit({
        ...policy.defaultParams,
        ...(source.params && typeof source.params === "object" && !Array.isArray(source.params)
          ? source.params as Record<string, unknown>
          : {}),
      }) as Record<string, unknown>;
    const transformedParams = applyParameterTransforms(
      mergedParams,
      policy.parameterTransforms,
    );
    const actionExecutionFields = source.type === "action"
      ? {
          retries: source.retries ?? runtimeDefault("actionRetries"),
          retryDelayMs: source.retryDelayMs ?? source.retryDelay ?? runtimeDefault("actionRetryDelayMs"),
          delayAfterMs: source.delayAfterMs ?? source.delay_after ?? runtimeDefault("actionDelayAfterMs"),
          timeoutMs: source.timeoutMs ?? runtimeDefault("actionTimeoutMs"),
        }
      : {};
    const pollingFields = Object.prototype.hasOwnProperty.call(source, "outputPath")
      ? {
          pollIntervalMs: source.pollIntervalMs ?? runtimeDefault("pollIntervalMs"),
          timeoutMs: source.timeoutMs ?? runtimeDefault("pollTimeoutMs"),
        }
      : {};
    return {
      ...hydrated,
      ...actionExecutionFields,
      ...pollingFields,
      params: transformedParams,
      ...(source.primitive === true || source.type !== "action" ? { primitive: true } : {}),
      nativeOpcode: policy.nativeOpcode,
      observationOnly: policy.observationOnly,
      verificationOpcode: opcodeFrom("verificationOpcodes", verificationMode),
      verificationStrategy: executionString("verificationStrategy"),
      l1TimeoutMs: executionNumber("l1TimeoutMs"),
      l2SettleMs: executionNumber("l2SettleMs"),
      ...(source.type === "action"
        && source.failureOpcode === undefined
        ? {
            failureOpcode: failureMode
              ? opcodeFrom("failureOpcodes", failureMode)
              : opcodeFrom("failureOpcodes", interpreterPolicy.defaultFailureMode),
          }
        : {}),
    };
  };
  const visited = visit(template) as T & Record<string, unknown>;
  const sourceRecovery = template.recoveryPolicy
    && typeof template.recoveryPolicy === "object"
    && !Array.isArray(template.recoveryPolicy)
    ? template.recoveryPolicy as Record<string, unknown>
    : {};
  return {
    ...visited,
    recoveryPolicy: {
      ...sourceRecovery,
      autonomy: sourceRecovery.autonomy ?? runtimeDefault("recoveryAutonomy"),
      aiRecoveryEnabled: sourceRecovery.aiRecoveryEnabled ?? runtimeDefault("recoveryAiEnabled"),
      maxAttemptsPerStep: sourceRecovery.maxAttemptsPerStep ?? runtimeDefault("recoveryMaxAttemptsPerStep"),
      maxAttemptsPerWorkflow: sourceRecovery.maxAttemptsPerWorkflow ?? runtimeDefault("recoveryMaxAttemptsPerWorkflow"),
      maxRecoveryActionsPerAttempt: sourceRecovery.maxRecoveryActionsPerAttempt
        ?? runtimeDefault("recoveryMaxActionsPerAttempt"),
      allowedRecoveryRequests: sourceRecovery.allowedRecoveryRequests
        ?? template.allowedRecoveryRequests
        ?? runtimeDefault("recoveryAllowedRequests"),
      requireStateVerification: sourceRecovery.requireStateVerification
        ?? runtimeDefault("recoveryRequireStateVerification"),
      learnFromFailure: sourceRecovery.learnFromFailure ?? runtimeDefault("recoveryLearnFromFailure"),
      plannerInstruction: sourceRecovery.plannerInstruction ?? runtimeDefault("recoveryPlannerInstruction"),
      executeDecisionKey: sourceRecovery.executeDecisionKey ?? runtimeDefault("recoveryExecuteDecisionKey"),
      retryDecisionKey: sourceRecovery.retryDecisionKey ?? runtimeDefault("recoveryRetryDecisionKey"),
      abortDecisionKey: sourceRecovery.abortDecisionKey ?? runtimeDefault("recoveryAbortDecisionKey"),
      probeActionKey: sourceRecovery.probeActionKey ?? runtimeDefault("recoveryProbeActionKey"),
      probeTimeoutMs: sourceRecovery.probeTimeoutMs ?? runtimeDefault("recoveryProbeTimeoutMs"),
      plannerSystem: sourceRecovery.plannerSystem ?? runtimeDefault("recoveryPlannerSystem"),
      plannerMaxTokens: sourceRecovery.plannerMaxTokens ?? runtimeDefault("recoveryPlannerMaxTokens"),
      plannerTimeoutMs: sourceRecovery.plannerTimeoutMs ?? runtimeDefault("recoveryPlannerTimeoutMs"),
    },
    executionStates,
    jobExecutionStates,
    enginePolicy: interpreterPolicy.enginePolicy,
  };
}

async function loadJobActionPolicy(type: JobType): Promise<JobActionPolicy> {
  const result = await getDb().query<{ policy: Record<string, unknown> }>(
    `SELECT entry.payload->'jobActionPolicy' AS policy
       FROM runtime_semantic_entries entry
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE definition.dispatchable
        AND entry.payload->'jobActionPolicy'->>'actionKey' = $1
      ORDER BY entry.priority DESC, entry.id`,
    [type],
  );
  if (result.rows.length !== 1) {
    throw new Error(`PostgreSQL job action policy is missing or ambiguous for '${type}'`);
  }
  const policy = result.rows[0].policy;
  if (
    typeof policy.allowed !== "boolean"
    || typeof policy.requiresRoot !== "boolean"
    || !Number.isSafeInteger(policy.nativeOpcode)
    || Number(policy.nativeOpcode) < 0
    || !Number.isSafeInteger(policy.verificationOpcode)
    || Number(policy.verificationOpcode) < 0
  ) {
    throw new Error(`PostgreSQL job action policy is invalid for '${type}'`);
  }
  return {
    allowed: policy.allowed,
    requiresRoot: policy.requiresRoot,
    nativeOpcode: Number(policy.nativeOpcode),
    observationOnly: policy.observationOnly === true,
    verificationOpcode: Number(policy.verificationOpcode),
    timeoutPerUnitMs: typeof policy.timeoutPerUnitMs === "number" && policy.timeoutPerUnitMs >= 0
      ? policy.timeoutPerUnitMs
      : null,
    timeoutBaseMs: typeof policy.timeoutBaseMs === "number" && policy.timeoutBaseMs >= 0
      ? policy.timeoutBaseMs
      : 0,
    timeoutInputPath: typeof policy.timeoutInputPath === "string" && policy.timeoutInputPath.trim()
      ? policy.timeoutInputPath.trim()
      : null,
    executionPolicy: policy.executionPolicy && typeof policy.executionPolicy === "object" && !Array.isArray(policy.executionPolicy)
      ? policy.executionPolicy as Record<string, unknown>
      : {},
    parameterTransforms: Array.isArray(policy.parameterTransforms) ? policy.parameterTransforms : [],
    defaultParams: policy.defaultParams && typeof policy.defaultParams === "object" && !Array.isArray(policy.defaultParams)
      ? policy.defaultParams as Record<string, unknown>
      : {},
  };
}

function readTimeoutInput(params: unknown, path: string | null): unknown {
  if (!path) return undefined;
  let current: unknown = params;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error("PostgreSQL parameter transform targetPath is empty");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

export function applyParameterTransforms(
  params: Record<string, unknown>,
  transforms: unknown[],
): Record<string, unknown> {
  const output = structuredClone(params);
  for (const rawTransform of transforms) {
    if (!rawTransform || typeof rawTransform !== "object" || Array.isArray(rawTransform)) {
      throw new Error("PostgreSQL parameter transform must be an object");
    }
    const transform = rawTransform as Record<string, unknown>;
    const sourcePath = typeof transform.sourcePath === "string" ? transform.sourcePath.trim() : "";
    const sourceValue = readTimeoutInput(output, sourcePath);
    if (sourceValue === undefined) continue;
    const values = transform.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(`PostgreSQL parameter transform values are invalid for '${sourcePath}'`);
    }
    const lookup = values as Record<string, unknown>;
    const transformOpcode = transform.transformOpcode;
    if (transformOpcode === 0) {
      const mapped = lookup[String(sourceValue)];
      if (!mapped || typeof mapped !== "object" || Array.isArray(mapped)) {
        throw new Error(`PostgreSQL parameter mapping is missing for '${sourcePath}.${String(sourceValue)}'`);
      }
      const mapping = mapped as Record<string, unknown>;
      const targetPath = typeof mapping.targetPath === "string" ? mapping.targetPath.trim() : "";
      if (!targetPath || !Object.prototype.hasOwnProperty.call(mapping, "value")) {
        throw new Error(`PostgreSQL scalar parameter mapping is invalid for '${sourcePath}.${String(sourceValue)}'`);
      }
      writePath(output, targetPath, mapping.value);
    } else if (transformOpcode === 1) {
      if (!Array.isArray(sourceValue)) {
        throw new Error(`PostgreSQL array parameter transform expected an array at '${sourcePath}'`);
      }
      const targetPath = typeof transform.targetPath === "string" ? transform.targetPath.trim() : "";
      if (!targetPath) throw new Error(`PostgreSQL array parameter transform targetPath is invalid for '${sourcePath}'`);
      const mapped = sourceValue.map((item) => {
        const value = lookup[String(item)];
        if (value === undefined) {
          throw new Error(`PostgreSQL parameter mapping is missing for '${sourcePath}.${String(item)}'`);
        }
        return value;
      });
      writePath(output, targetPath, mapped);
    } else {
      throw new Error(`PostgreSQL parameter transform opcode is invalid for '${sourcePath}'`);
    }
  }
  return output;
}

export function workflowChildTimeoutDisposition(
  ownership: {
    root_initial: boolean;
    operation_initial: boolean;
    operation_in_flight: boolean;
  } | undefined,
  observedDispatch: boolean,
): { deferred: boolean; armExecution: boolean } {
  return {
    deferred: ownership?.root_initial === true && ownership.operation_initial === true,
    armExecution: !observedDispatch && ownership?.operation_in_flight === true,
  };
}

export function shouldBlockRootForTimedOutJob(workflowId?: string): boolean {
  return !workflowId;
}

interface DispatchCoreOptions {
  legacyCompatibilityLane?: boolean;
}

export class DispatcherService {
  async hydrateWorkflowNativePolicies<T extends Record<string, unknown>>(template: T): Promise<T> {
    return hydrateWorkflowNativePolicies(template);
  }

  private queues = new Map<string, Queue>();

  private getQueue(deviceId: string): Queue {
    if (!this.queues.has(deviceId)) {
      // Use plain connection options — BullMQ has its own bundled ioredis
      // and passing our IORedis instance causes type conflicts between versions.
      const queue = new Queue(`device_${deviceId}`, {
        connection: getRedisConnectionOptions(),
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      });
      this.queues.set(deviceId, queue);
    }
    return this.queues.get(deviceId)!;
  }

  async dispatch(req: DispatchJobRequest): Promise<{
    jobId: string;
    timeoutMs: number;
    requiresRoot: boolean;
    nativeOpcode: number;
    observationOnly: boolean;
    verificationOpcode: number;
    resultStatuses: { active: string; succeeded: string; failed: string };
    verificationStrategy: string;
    l1TimeoutMs: number;
    l2SettleMs: number;
    executionPolicy: Record<string, unknown>;
    params: JobParams;
  }> {
    return this.dispatchCore(req, {});
  }

  async dispatchLegacyGeneratedWorkflow(req: DispatchJobRequest): Promise<{
    jobId: string;
    timeoutMs: number;
    requiresRoot: boolean;
    nativeOpcode: number;
    observationOnly: boolean;
    verificationOpcode: number;
    resultStatuses: { active: string; succeeded: string; failed: string };
    verificationStrategy: string;
    l1TimeoutMs: number;
    l2SettleMs: number;
    executionPolicy: Record<string, unknown>;
    params: JobParams;
  }> {
    return this.dispatchCore(req, { legacyCompatibilityLane: true });
  }

  private async dispatchCore(
    req: DispatchJobRequest,
    { legacyCompatibilityLane = false }: DispatchCoreOptions,
  ): Promise<{
    jobId: string;
    timeoutMs: number;
    requiresRoot: boolean;
    nativeOpcode: number;
    observationOnly: boolean;
    verificationOpcode: number;
    resultStatuses: { active: string; succeeded: string; failed: string };
    verificationStrategy: string;
    l1TimeoutMs: number;
    l2SettleMs: number;
    executionPolicy: Record<string, unknown>;
    params: JobParams;
  }> {

    // 0. Kill switch — block all dispatches when active (B4 fix)
    if (await isKillSwitchActive()) {
      throw new Error("Kill switch active — job dispatch blocked");
    }

    // 1. PostgreSQL action authorization.
    const actionPolicy = await loadJobActionPolicy(req.type);
    if (!actionPolicy.allowed) {
      throw new Error(`Job type '${req.type}' is not allowed.`);
    }

    // 2. Root commands require explicit confirmation
    if (actionPolicy.requiresRoot && !req.confirmRoot) {
      throw new Error(
        `Job type '${req.type}' is a root command and requires confirmRoot=true.`
      );
    }
    const resolvedParams = applyParameterTransforms(
      {
        ...actionPolicy.defaultParams,
        ...(req.params as Record<string, unknown>),
      },
      actionPolicy.parameterTransforms,
    ) as JobParams;
    const executionPolicy = actionPolicy.executionPolicy;
    const requiredNumberPolicy = (key: string): number => {
      const value = executionPolicy[key];
      if (!Number.isFinite(value) || Number(value) < 0) {
        throw new Error(`PostgreSQL job execution policy is missing numeric '${key}'`);
      }
      return Number(value);
    };
    const verificationStrategy = typeof req.verificationStrategy === "string" && req.verificationStrategy.trim()
      ? req.verificationStrategy.trim()
      : typeof executionPolicy.verificationStrategy === "string" && executionPolicy.verificationStrategy.trim()
        ? executionPolicy.verificationStrategy.trim()
        : (() => { throw new Error("PostgreSQL job execution policy is missing verificationStrategy"); })();
    const l1TimeoutMs = req.l1TimeoutMs ?? requiredNumberPolicy("l1TimeoutMs");
    const l2SettleMs = req.l2SettleMs ?? requiredNumberPolicy("l2SettleMs");

    // 3. Calculate timeout from the PostgreSQL action policy. The engine does
    // not branch on action names; policy may size a timeout from any string or
    // array field selected by timeoutInputPath.
    let calculatedTimeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let skipMaxClamp = false;

    const timeoutInput = readTimeoutInput(resolvedParams, actionPolicy.timeoutInputPath);
    const timeoutUnits = typeof timeoutInput === "string" || Array.isArray(timeoutInput)
      ? timeoutInput.length
      : 0;
    if (actionPolicy.timeoutPerUnitMs !== null && timeoutUnits > 0) {
      calculatedTimeout = actionPolicy.timeoutBaseMs + timeoutUnits * actionPolicy.timeoutPerUnitMs;
      skipMaxClamp = true;
    }
    
    const timeoutMs = skipMaxClamp ? calculatedTimeout : Math.min(calculatedTimeout, MAX_TIMEOUT_MS);
    const resultStatuses = await getResourceLifecycleExecutionStatusContract("jobs");

    // 4. Persist job to DB
    const db = getDb();
    const jobId = uuidv4();
    await db.query(
      `INSERT INTO jobs (id, device_id, job_type, params, timeout_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, req.deviceId, req.type, JSON.stringify(resolvedParams), timeoutMs]
    );
    recordJobExecutionEventDetached({
      jobId,
      deviceId: req.deviceId,
      workflowId: req.workflowId ?? null,
      source: "dispatcher",
      eventType: "job_created",
      details: {
        jobType: req.type,
        timeoutMs,
        stepIndex: req.stepIndex ?? null,
        legacyCompatibilityLane,
      },
    });

    if (!legacyCompatibilityLane) {
      await deviceExecutionArbiter.observeAdmission({
        deviceId: req.deviceId,
        rootKind: req.workflowId ? "server_workflow" : "job",
        externalId: req.workflowId ?? jobId,
        requestKey: req.workflowId ?? jobId,
        actor: "dispatcher",
        metadata: {
          jobType: req.type,
          workflowId: req.workflowId ?? null,
          canonicalRoot: Boolean(req.workflowId),
          stepIndex: req.stepIndex ?? null,
          observeSource: "dispatcher.dispatch",
        },
      });
    }

    // 5. Audit log (dispatch record — result_status updated when JOB_RESULT arrives)
    // Skip if workflowId present — workflow executor writes its own audit log entry
    if (!req.workflowId) {
      await db.query(
        `INSERT INTO command_log (device_id, job_id, command_type, command_raw, command_params)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.deviceId, jobId, req.type, `${req.type} → ${req.deviceId}`, JSON.stringify(resolvedParams)]
      );
    }

    // 6. Enqueue to BullMQ
    // Note: BullMQ v5 removed the `timeout` option from JobsOptions.
    // Timeout enforcement is handled server-side via setTimeout above.
    const queue = this.getQueue(req.deviceId);
    await queue.add(
      "job",
      { jobId, deviceId: req.deviceId, type: req.type, params: resolvedParams, timeoutMs },
      { jobId }
    );

    if (!legacyCompatibilityLane) {
      if (isPnqV2ShadowRuntimeEnabled()) {
        // Create the observation promise synchronously so prepareShadowDispatch()
        // can always see and await this job's mapping in shadow mode.
        const shadowEnqueueObservation = pnqV2RuntimeService.enqueueShadowJob({
          deviceId: req.deviceId,
          legacyJobId: jobId,
          payload: { type: req.type, params: resolvedParams, workflowId: req.workflowId ?? null },
          timeoutMs,
        });
        runPnqV2ShadowSideEffect("enqueue", () => shadowEnqueueObservation);
      }
    }

    // Server-side timeout enforcement:
    // If device executes job but never sends JOB_RESULT (crash, connection loss),
    // job would stay 'running' forever without this.
    let observedWorkflowChildDispatch = false;
    const enforceTimeout = async () => {
      try {
        const job = await this.getJob(jobId);
        if (job) {
          const db = getDb();

          // A server-workflow child can remain durably queued behind another
          // PNQ root for longer than its execution timeout.  Its execution
          // clock must not start until PNQ actually advances the operation to
          // the wire.  Otherwise a perfectly valid queued child is timed out
          // locally and the whole workflow root is marked ambiguous before it
          // ever reaches the phone.
          if (!legacyCompatibilityLane && !shouldBlockRootForTimedOutJob(req.workflowId)) {
            const ownership = await db.query<{
              root_initial: boolean;
              operation_initial: boolean;
              operation_in_flight: boolean;
            }>(
              `SELECT
                 lifecycle_state_matches(
                   'device_execution_roots'::regclass,
                   roots.state,
                   '{"initial":true}'::jsonb
                 ) AS root_initial,
                 lifecycle_state_matches(
                   'device_execution_operations'::regclass,
                   operations.state,
                   '{"initial":true}'::jsonb
                 ) AS operation_initial,
                 lifecycle_state_matches(
                   'device_execution_operations'::regclass,
                   operations.state,
                   '{"initial":false,"terminal":false,"administrative":false}'::jsonb
                 ) AS operation_in_flight
               FROM device_execution_operations operations
               JOIN device_execution_roots roots ON roots.id = operations.root_id
               WHERE operations.operation_kind = 'job'
                 AND operations.operation_id = $1
               LIMIT 1`,
              [jobId],
            );
            const current = ownership.rows[0];
            const disposition = workflowChildTimeoutDisposition(current, observedWorkflowChildDispatch);
            if (disposition.deferred) {
              const retry = setTimeout(enforceTimeout, 1_000);
              retry.unref?.();
              return;
            }
            if (disposition.armExecution) {
              observedWorkflowChildDispatch = true;
              const executionTimer = setTimeout(enforceTimeout, timeoutMs + 5_000);
              executionTimer.unref?.();
              return;
            }
          }

          const expired = await transitionJobByConfiguredStalePolicy(jobId, db);
          if (!expired) return;
          await db.query(
            "UPDATE command_log SET result_status = $1 WHERE job_id = $2",
            [expired.status, jobId]
          );
          recordJobExecutionEventDetached({
            jobId,
            deviceId: req.deviceId,
            workflowId: req.workflowId ?? null,
            source: "dispatcher",
            eventType: "dispatcher_timeout",
            details: { jobType: req.type, timeoutMs },
          });
          if (req.workflowId) {
            // The server workflow owns the device root and decides whether a
            // timed-out child is retried or the workflow is failed. Blocking
            // the whole root here races the workflow executor and prevents the
            // next idempotent readiness child (notably unlock) from dispatching.
            return;
          }
          if (!legacyCompatibilityLane) {
            await deviceExecutionArbiter.markAmbiguous({
              deviceId: req.deviceId,
              rootKind: "job",
              externalId: jobId,
              reason: "job_timeout",
              actor: "dispatcher_timeout",
              metadata: { timeoutMs, jobType: req.type },
            });
          }
        }
      } catch (err) {
        console.error(`[dispatcher] Timeout handler error for job ${jobId}:`, (err as Error).message);
      }
    };
    const timeoutHandle = setTimeout(enforceTimeout, timeoutMs + 5_000); // +5s grace period for network latency
    timeoutHandle.unref?.();

    return {
      jobId,
      timeoutMs,
      requiresRoot: actionPolicy.requiresRoot,
      nativeOpcode: actionPolicy.nativeOpcode,
      observationOnly: actionPolicy.observationOnly,
      verificationOpcode: actionPolicy.verificationOpcode,
      resultStatuses: {
        active: resultStatuses.active,
        succeeded: resultStatuses.succeeded,
        failed: resultStatuses.failed,
      },
      verificationStrategy,
      l1TimeoutMs,
      l2SettleMs,
      executionPolicy,
      params: resolvedParams,
    };
  }

  /**
   * Called by WebSocket layer when a JOB_RESULT arrives from the device.
   */
  async handleJobResult(payload: {
    jobId: string;
    deviceId: string;
    success: boolean;
    output?: unknown;
    error?: string;
    durationMs: number;
    authority?: "legacy_generated_workflow";
  }): Promise<void> {
    const db = getDb();
    const completedAt = new Date();

    // Compute started_at in TypeScript to avoid using $4 twice in the same query
    // (PostgreSQL throws "inconsistent types deduced for parameter $4" on dual-cast usage).
    const startedAt = payload.durationMs > 0
      ? new Date(completedAt.getTime() - payload.durationMs)
      : null;

    const transitioned = await transitionJob(payload.jobId, {
      targetTerminal: true,
      targetRetryable: !payload.success,
      targetAdministrative: false,
      transitionExternalAllowed: true,
    }, {
      output: payload.output ?? null,
      error: payload.error ?? null,
      durationMs: payload.durationMs,
      startedAt,
    }, db, payload.deviceId);
    if (!transitioned) {
      throw new Error("DB lifecycle rejected external job result transition");
    }

    // Update audit log with final result status.
    // command_log is append-mostly — this single UPDATE per job (dispatch → completion)
    // is intentional and documented. If strict immutability is required, use
    // a second INSERT with event_type='result' instead.
    await db.query(
      "UPDATE command_log SET result_status = $1 WHERE job_id = $2",
      [transitioned.status, payload.jobId]
    );
    recordJobExecutionEventDetached({
      jobId: payload.jobId,
      deviceId: payload.deviceId,
      source: "dispatcher",
      eventType: "job_result_persisted",
      details: {
        status: transitioned.status,
        durationMs: payload.durationMs,
        error: payload.error ?? null,
        authority: payload.authority ?? null,
      },
    });

    if (payload.authority === "legacy_generated_workflow") return;

    const terminalObservation = {
      deviceId: payload.deviceId,
      rootKind: "job" as const,
      externalId: payload.jobId,
      terminalSelector: {
        targetTerminal: true,
        targetRetryable: !payload.success,
        targetAdministrative: false,
        transitionExternalAllowed: true,
      },
      actor: "dispatcher_result",
      reason: payload.error ?? transitioned.status,
      metadata: {
        outputPresent: payload.output !== undefined,
        durationMs: payload.durationMs,
      },
    };
    if (isDeviceExecutionEnforced()) {
      await deviceExecutionArbiter.observeTerminal(terminalObservation);
    } else {
      void deviceExecutionArbiter.observeTerminal(terminalObservation);
    }
  }

  async getJob(jobId: string): Promise<Job | null> {
    const db = getDb();
    const result = await db.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
    if (result.rows.length === 0) return null;
    return rowToJob(result.rows[0]);
  }

  async listJobs(
    deviceId?: string,
    page = 1,
    pageSize = 50
  ): Promise<{ items: Job[]; total: number; page: number; pageSize: number }> {
    const db = getDb();
    const offset = (page - 1) * pageSize;
    const rowsWhere = deviceId ? "WHERE device_id = $3" : "";
    const countWhere = deviceId ? "WHERE device_id = $1" : "";
    const values = deviceId
      ? [pageSize, offset, deviceId]
      : [pageSize, offset];

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT * FROM jobs ${rowsWhere} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        values
      ),
      db.query(`SELECT COUNT(*) FROM jobs ${countWhere}`, deviceId ? [deviceId] : []),
    ]);

    return {
      items: rows.rows.map(rowToJob),
      total: parseInt(countRow.rows[0].count, 10),
      page,
      pageSize,
    };
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const row = await transitionJob(jobId, {
      targetTerminal: true,
      targetAdministrative: true,
      transitionManualAllowed: true,
    });
    if (!row) return false;
    await deviceExecutionArbiter.observeTerminal({
      deviceId: row.device_id,
      rootKind: "job",
      externalId: row.id,
      status: row.status,
      actor: "dispatcher_cancel",
      reason: "queued_job_cancelled",
    });
    return true;
  }

  async sweepStaleJobs(): Promise<{ expiredCount: number; jobIds: string[] }> {
    const expired = await expireStaleJobs();
    for (const row of expired) {
      await getDb().query(
        "UPDATE command_log SET result_status = $1 WHERE job_id = $2",
        [row.status, row.id],
      );
      recordJobExecutionEventDetached({
        jobId: row.id,
        deviceId: row.device_id,
        source: "dispatcher",
        eventType: "dispatcher_timeout",
        details: { authority: "db_lifecycle_stale_policy" },
      });
    }
    return { expiredCount: expired.length, jobIds: expired.map((row) => row.id) };
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
  }
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    deviceId: row.device_id as string,
    type: row.job_type as JobType,
    params: row.params as JobParams,
    status: row.status as Job["status"],
    output: row.output ?? undefined,
    error: (row.error as string) ?? undefined,
    durationMs: (row.duration_ms as number) ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
    startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
    completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null,
  };
}

export const dispatcherService = new DispatcherService();
