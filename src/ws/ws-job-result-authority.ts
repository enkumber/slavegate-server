import { deviceExecutionArbiter } from "../modules/device-execution";
import { isDeviceExecutionEnforced } from "../modules/device-execution/device-execution-authority";
import { runPnqV2ShadowSideEffect } from "../modules/device-execution/pnq-v2-runtime.service";

export type WsJobResultAuthorityInput = Parameters<typeof deviceExecutionArbiter.acceptJobResult>[0];

export interface WsJobResultAuthorityDecision {
  accepted: boolean;
  decision: string;
  reason?: string;
}

export async function evaluateWsJobResultAuthority(
  input: WsJobResultAuthorityInput,
): Promise<WsJobResultAuthorityDecision> {
  if (!isDeviceExecutionEnforced()) {
    runPnqV2ShadowSideEffect("ws observe-only result", () => deviceExecutionArbiter.observeTerminal({
      deviceId: input.deviceId,
      rootKind: "job",
      externalId: input.jobId,
      status: input.status,
      actor: "ws.observe_only",
      reason: input.reason ?? input.status,
      metadata: {
        ...(input.metadata ?? {}),
        authorityMode: "observe_only",
      },
    }));
    return { accepted: true, decision: "observe_only" };
  }

  try {
    return await deviceExecutionArbiter.acceptJobResult(input);
  } catch (err) {
    const reason = (err as Error).message;
    console.error("[device-execution] enforced WS JOB result ingress failed:", reason);
    return { accepted: false, decision: "enforced_error", reason };
  }
}
