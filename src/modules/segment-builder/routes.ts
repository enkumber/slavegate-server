import { Router, type NextFunction, type Request, type Response } from "express";
import crypto from "crypto";
import {
  segmentBuilderAgentToken,
  segmentBuildJobService,
} from "./segment-build-job.service";
import { authenticateRequest } from "../../api/auth.middleware";
import { humanWorkflowCompilerService } from "../human-workflow/human-workflow-compiler.service";
import { queueHumanAgencyWorkflowRun } from "../../api/routes";
import { segmentBuilderRuntimePolicy } from "./runtime-policy";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function normalizedAddress(value: string | undefined): string {
  if (!value) return "";
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

async function requestedAgentId(req: Request, res: Response): Promise<string | null> {
  const policy = await segmentBuilderRuntimePolicy();
  const value = req.body?.agentId;
  if (value !== undefined && value !== policy.agentId) {
    res.status(403).json({
      ok: false,
      code: "SEGMENT_BUILDER_AGENT_FORBIDDEN",
      error: "agent identity is fixed",
    });
    return null;
  }
  return policy.agentId;
}

async function requireSegmentBuilder(req: Request, res: Response, next: NextFunction): Promise<void> {
  let policy;
  try {
    policy = await segmentBuilderRuntimePolicy();
  } catch {
    res.status(503).json({
      ok: false,
      code: "SEGMENT_BUILDER_POLICY_UNAVAILABLE",
      error: "Segment Builder runtime policy is unavailable",
    });
    return;
  }
  try {
    const principal = await authenticateRequest(req);
    if (principal?.kind !== "api_token" || principal.purpose !== policy.apiTokenPurpose) {
      throw new Error("configured token purpose does not match");
    }
    (req as any).authPrincipal = principal;
    next();
    return;
  } catch {}

  const authorization = req.header("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const expected = await segmentBuilderAgentToken();
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  if (
    presentedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(presentedBytes, expectedBytes)
  ) {
    (req as any).authPrincipal = {
      kind: "api_token",
      purpose: policy.apiTokenPurpose,
    };
    next();
    return;
  }
  res.status(401).json({ ok: false, code: "SEGMENT_BUILDER_UNAUTHORIZED", error: "Unauthorized" });
}

router.use((req, res, next) => {
  void requireSegmentBuilder(req, res, next);
});

router.post("/dispatcher/register", asyncRoute(async (req, res) => {
  const policy = await segmentBuilderRuntimePolicy();
  const raw = typeof req.body?.callbackUrl === "string" ? req.body.callbackUrl.trim() : "";
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    return res.status(422).json({ ok: false, code: "SEGMENT_BUILDER_CALLBACK_INVALID", error: "invalid callback URL" });
  }

  const remoteAddress = normalizedAddress(req.socket.remoteAddress);
  const callbackHost = normalizedAddress(callback.hostname);
  if (
    !policy.callbackProtocols.includes(callback.protocol)
    || callback.port !== policy.callbackPort
    || callback.pathname !== policy.callbackPath
    || callback.search
    || callback.hash
    || !remoteAddress
    || (policy.requireCallbackAddressMatch && callbackHost !== remoteAddress)
  ) {
    return res.status(422).json({
      ok: false,
      code: "SEGMENT_BUILDER_CALLBACK_INVALID",
      error: "callback does not satisfy the configured segment-builder policy",
    });
  }

  const dispatcher = await segmentBuildJobService.registerDispatcher({
    id: policy.dispatcherId,
    callbackUrl: callback.toString(),
    registeredIp: remoteAddress,
  });
  res.json({ ok: true, data: dispatcher });
}));

router.get("/jobs/:id", asyncRoute(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: "invalid job id" });
  const job = await segmentBuildJobService.reconcileCanary(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "job not found" });
  res.json({ ok: true, data: job });
}));

router.get("/jobs/:id/context", asyncRoute(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: "invalid job id" });
  const context = await segmentBuildJobService.context(req.params.id);
  if (!context) return res.status(404).json({ ok: false, error: "job not found" });
  res.json({ ok: true, data: context });
}));

router.post("/jobs/:id/claim", asyncRoute(async (req, res) => {
  const agentId = await requestedAgentId(req, res);
  if (!agentId) return;
  const job = await segmentBuildJobService.claim(req.params.id, agentId);
  if (!job) return res.status(409).json({ ok: false, code: "SEGMENT_BUILD_JOB_NOT_CLAIMABLE", error: "job is not claimable" });
  res.json({ ok: true, data: job });
}));

router.post("/jobs/:id/heartbeat", asyncRoute(async (req, res) => {
  const agentId = await requestedAgentId(req, res);
  if (!agentId) return;
  const job = await segmentBuildJobService.heartbeat(req.params.id, agentId);
  if (!job) return res.status(409).json({ ok: false, error: "job lease is not active" });
  res.json({ ok: true, data: job });
}));

router.post("/jobs/:id/reconcile-blocked", asyncRoute(async (req, res) => {
  const agentId = await requestedAgentId(req, res);
  if (!agentId) return;
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const result = await segmentBuildJobService.reconcileBlockedForRetry({
    id: req.params.id,
    agentId,
    reason,
  });
  if (!result) {
    return res.status(409).json({
      ok: false,
      code: "SEGMENT_BUILD_BLOCKED_RECONCILE_NOT_ELIGIBLE",
      error: "blocked job is not eligible for reconciliation",
    });
  }
  res.json({ ok: true, data: result.job, reconciled: result.reconciled });
}));

router.post("/jobs/:id/candidate", asyncRoute(async (req, res) => {
  try {
    const agentId = await requestedAgentId(req, res);
    if (!agentId) return;
    const candidate = req.body?.candidate;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return res.status(422).json({ ok: false, error: "candidate object is required" });
    }
    const job = await segmentBuildJobService.submitCandidate(req.params.id, agentId, candidate);
    if (!job) return res.status(409).json({ ok: false, error: "candidate cannot be submitted for this job" });
    res.json({ ok: true, data: job });
  } catch (error) {
    const typed = error as Error & { status?: number; code?: string; validationErrors?: string[] };
    res.status(typed.status ?? 500).json({
      ok: false,
      code: typed.code,
      error: typed.message,
      errors: typed.validationErrors,
    });
  }
}));

router.post("/jobs/:id/canary", asyncRoute(async (req, res) => {
  try {
    const agentId = await requestedAgentId(req, res);
    if (!agentId) return;
    const job = await segmentBuildJobService.get(req.params.id);
    if (
      !job
      || job.assignedAgent !== agentId
      || typeof job.result.compositionName !== "string"
      || typeof job.result.compositionVersion !== "string"
    ) {
      return res.status(409).json({ ok: false, code: "SEGMENT_BUILD_CANARY_NOT_READY", error: "candidate is not ready for canary" });
    }
    const compiled = await humanWorkflowCompilerService.compileCandidateComposition({
      compositionName: job.result.compositionName,
      compositionVersion: job.result.compositionVersion,
      deviceId: job.deviceId,
      accountId: job.accountId,
      intent: job.intent,
    });
    if (!compiled.executionKey) {
      throw Object.assign(new Error("candidate composition did not produce an execution key"), {
        status: 500,
        code: "SEGMENT_BUILD_EXECUTION_KEY_MISSING",
      });
    }
    const reserved = await segmentBuildJobService.reserveCanary({
      id: job.id,
      agentId,
      executionKey: compiled.executionKey,
      requestKey: compiled.requestKey,
    });
    if (!reserved) {
      return res.status(409).json({ ok: false, code: "SEGMENT_BUILD_CANARY_RACE", error: "candidate state changed before canary started" });
    }
    try {
      const run = await queueHumanAgencyWorkflowRun({
        requestKey: compiled.requestKey,
        cacheKey: compiled.cacheKey,
        target: compiled.target,
        intent: job.intent,
        compiledBy: agentId,
        allowCandidateArtifact: true,
        architecture: compiled.architecture,
        compositionKey: compiled.compositionKey,
        executionKey: compiled.executionKey,
        segmentKeys: compiled.segmentKeys,
        segmentRefs: compiled.segmentRefs,
        runtimeInputs: compiled.runtimeInputs,
      });
      const started = await segmentBuildJobService.attachCanaryRun({
        id: job.id,
        agentId,
        executionKey: compiled.executionKey,
        runId: String(run.id),
        taskId: String(run.taskId),
      });
      if (!started) {
        return res.status(409).json({
          ok: false,
          code: "SEGMENT_BUILD_CANARY_STATE_LOST",
          error: "canary was queued but the build job state could not be attached",
        });
      }
      res.status(202).json({ ok: true, data: started });
    } catch (error) {
      await segmentBuildJobService.canaryDispatchFailed(
        job.id,
        agentId,
        (error as Error).message,
      );
      throw error;
    }
  } catch (error) {
    const typed = error as Error & { status?: number; code?: string; validationErrors?: string[] };
    res.status(typed.status ?? 500).json({
      ok: false,
      code: typed.code,
      error: typed.message,
      errors: typed.validationErrors,
    });
  }
}));

router.post("/jobs/:id/fail", asyncRoute(async (req, res) => {
  const agentId = await requestedAgentId(req, res);
  if (!agentId) return;
  const error = typeof req.body?.error === "string" ? req.body.error : "segment builder failed";
  const job = await segmentBuildJobService.fail(req.params.id, agentId, error, req.body?.blocked === true);
  if (!job) return res.status(409).json({ ok: false, error: "job cannot be failed" });
  res.json({ ok: true, data: job });
}));

export default router;
