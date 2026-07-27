import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();

const workflowLifecycle = "gate_workflow_lifecycle";
const semanticLifecycle = "gate_semantic_lifecycle";
const templateId = "gate_db_only_workflow";

const state = async (lifecycleKey, status, flags = {}) => {
  await client.query(
    `INSERT INTO lifecycle_state_definitions (
       lifecycle_key, status, initial, terminal, retryable, administrative,
       dispatchable, manual, sort_order, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,'{}'::jsonb)`,
    [
      lifecycleKey,
      status,
      flags.initial ?? false,
      flags.terminal ?? false,
      flags.retryable ?? false,
      flags.administrative ?? false,
      flags.dispatchable ?? false,
      flags.sortOrder ?? 0,
    ],
  );
};

const actionPolicy = (actionKey, nativeOpcode) => ({
  jobActionPolicy: {
    actionKey,
    allowed: true,
    requiresRoot: false,
    nativeOpcode,
    verificationOpcode: 0,
    observationOnly: false,
    defaultParams: {},
    executionPolicy: {},
    parameterTransforms: [],
  },
});

const interpreterPolicy = (actionTimeoutMs) => ({
  workflowInterpreterPolicy: {
    distributionOpcodes: { gate_distribution: 0 },
    conditionOpcodes: { gate_condition: 0 },
    predicateOpcodes: { gate_predicate: 0 },
    failureOpcodes: { gate_fail: 0 },
    defaultFailureMode: "gate_fail",
    verificationOpcodes: { gate_verify: 0 },
    defaultVerificationMode: "gate_verify",
    runtimeDefaults: {
      actionRetries: 0,
      actionRetryDelayMs: 0,
      actionDelayAfterMs: 0,
      actionTimeoutMs,
      pollIntervalMs: 1,
      pollTimeoutMs: 1,
      conditionProbability: 1,
      regexGroup: 0,
      recoveryAutonomy: "gate_disabled",
      recoveryAiEnabled: false,
      recoveryMaxAttemptsPerStep: 0,
      recoveryMaxAttemptsPerWorkflow: 0,
      recoveryMaxActionsPerAttempt: 0,
      recoveryAllowedRequests: [],
      recoveryRequireStateVerification: false,
      recoveryLearnFromFailure: false,
      recoveryPlannerInstruction: "",
      recoveryExecuteDecisionKey: "",
      recoveryRetryDecisionKey: "",
      recoveryAbortDecisionKey: "",
      recoveryProbeActionKey: "gate_probe",
      recoveryProbeTimeoutMs: 1,
      recoveryPlannerSystem: "",
      recoveryPlannerMaxTokens: 1,
      recoveryPlannerTimeoutMs: 1,
    },
    enginePolicy: {
      maxNestedDepth: 1,
      minActionTimeoutMs: 1,
      captureTimeoutMs: 1,
      defaultSubstepTimeoutMs: 1,
      substepTimeoutPaddingMs: 1,
      ackTimeoutMs: 1,
      progressSweepMs: 1,
      progressGraceMs: 1,
      minStaleMs: 1,
      maxStaleMs: 1,
      localStepBudgetMs: 1,
    },
  },
});

const template = (action, marker) => ({
  id: templateId,
  name: "DB-only gate",
  platform: "gate",
  version: "1",
  runtimeContract: "edge-workflow/v2",
  defaultVerificationStrategy: "gate_verify",
  dataRetentionDays: 1,
  steps: [{ id: "gate_step", type: "action", action, params: { marker } }],
});

await client.query("BEGIN");
try {
  await state(workflowLifecycle, "gate_pending", { initial: true, sortOrder: 1 });
  await state(workflowLifecycle, "gate_running", { sortOrder: 2 });
  await state(workflowLifecycle, "gate_done", { terminal: true, sortOrder: 3 });
  await state(workflowLifecycle, "gate_error", { terminal: true, retryable: true, sortOrder: 4 });
  await state(workflowLifecycle, "gate_cancel", { terminal: true, administrative: true, sortOrder: 5 });
  await state(semanticLifecycle, "gate_available", { initial: true, dispatchable: true });
  await state(semanticLifecycle, "gate_retired", { terminal: true, administrative: true, sortOrder: 2 });
  await client.query(
    `INSERT INTO lifecycle_transitions (
       lifecycle_key, action_key, from_status, to_status, mark_started
     ) VALUES ($1,$2,$3,$4,TRUE)`,
    [workflowLifecycle, "gate_begin", "gate_pending", "gate_running"],
  );
  await client.query(
    `INSERT INTO lifecycle_resource_bindings(resource_table, lifecycle_key, state_column)
     VALUES ('workflows'::regclass, $1, 'status'),
            ('runtime_semantic_entries'::regclass, $2, 'status')`,
    [workflowLifecycle, semanticLifecycle],
  );
  await client.query(
    `INSERT INTO runtime_semantic_entries(
       namespace, entry_key, platform, status, priority, payload, lifecycle_key
     ) VALUES
       ($1,$2,'*',$3,1,$4::jsonb,$5),
       ($1,$6,'*',$3,1,$7::jsonb,$5)`,
    [
      "gate",
      "interpreter",
      "gate_available",
      JSON.stringify(interpreterPolicy(1111)),
      semanticLifecycle,
      "action_a",
      JSON.stringify(actionPolicy("gate_action_a", 41)),
    ],
  );
  await client.query(
    `INSERT INTO workflow_templates(
       id, platform, definition, data_retention_days, default_verification_strategy
     ) VALUES ($1,'gate',$2::jsonb,1,'gate_verify')`,
    [templateId, JSON.stringify(template("gate_action_a", "alpha"))],
  );
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
}

const { hydrateWorkflowNativePolicies } =
  await import("../dist/src/modules/dispatcher/dispatcher.service.js");
const { closeDb } = await import("../dist/src/db/client.js");

const loadAndHydrate = async () => {
  const result = await client.query(
    "SELECT definition FROM workflow_templates WHERE id = $1",
    [templateId],
  );
  return hydrateWorkflowNativePolicies(result.rows[0].definition);
};

const first = await loadAndHydrate();

await client.query(
  `UPDATE runtime_semantic_entries
      SET payload = $1::jsonb, updated_at = NOW()
    WHERE namespace = 'gate' AND entry_key = 'interpreter'`,
  [JSON.stringify(interpreterPolicy(2222))],
);
await client.query(
  `INSERT INTO runtime_semantic_entries(
     namespace, entry_key, platform, status, priority, payload, lifecycle_key
   ) VALUES ('gate','action_b','*','gate_available',2,$1::jsonb,$2)`,
  [JSON.stringify(actionPolicy("gate_action_b", 73)), semanticLifecycle],
);
await client.query(
  "UPDATE workflow_templates SET definition = $1::jsonb, updated_at = NOW() WHERE id = $2",
  [JSON.stringify(template("gate_action_b", "beta")), templateId],
);

const second = await loadAndHydrate();
const firstStep = first.steps[0];
const secondStep = second.steps[0];
if (
  firstStep.nativeOpcode !== 41
  || firstStep.timeoutMs !== 1111
  || firstStep.params.marker !== "alpha"
  || secondStep.nativeOpcode !== 73
  || secondStep.timeoutMs !== 2222
  || secondStep.params.marker !== "beta"
) {
  throw new Error(`DB-only gate failed: ${JSON.stringify({ firstStep, secondStep })}`);
}

await client.query(
  `UPDATE runtime_semantic_entries
      SET status = 'gate_retired', updated_at = NOW()
    WHERE namespace = 'gate' AND entry_key = 'action_b'`,
);
let retiredPolicyRejected = false;
try {
  await hydrateWorkflowNativePolicies(
    (await client.query(
      "SELECT definition FROM workflow_templates WHERE id = $1",
      [templateId],
    )).rows[0].definition,
  );
} catch {
  retiredPolicyRejected = true;
}
await client.query("DELETE FROM workflow_templates WHERE id = $1", [templateId]);
const remainingTemplates = Number(
  (await client.query(
    "SELECT COUNT(*)::int AS count FROM workflow_templates WHERE id = $1",
    [templateId],
  )).rows[0].count,
);
if (!retiredPolicyRejected || remainingTemplates !== 0) {
  throw new Error(`DB-only withdrawal gate failed: ${JSON.stringify({
    retiredPolicyRejected,
    remainingTemplates,
  })}`);
}

console.log(JSON.stringify({
  ok: true,
  sameProcess: true,
  first: {
    action: firstStep.action,
    nativeOpcode: firstStep.nativeOpcode,
    timeoutMs: firstStep.timeoutMs,
    marker: firstStep.params.marker,
  },
  second: {
    action: secondStep.action,
    nativeOpcode: secondStep.nativeOpcode,
    timeoutMs: secondStep.timeoutMs,
    marker: secondStep.params.marker,
  },
  withdrawal: {
    retiredPolicyRejected,
    remainingTemplates,
  },
}));

await closeDb();
await client.end();
