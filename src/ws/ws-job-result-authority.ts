import { deviceExecutionArbiter } from "../modules/device-execution";
import { isDeviceExecutionEnforced } from "../modules/device-execution/device-execution-authority";

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
    void Promise.resolve()
      .then(() => deviceExecutionArbiter.observeTerminal({
        deviceId: input.deviceId,
        rootKind: "job",
        externalId: input.jobId,
        terminalSelector: {
          targetTerminal: true,
          targetRetryable: !input.success,
          targetAdministrative: false,
          transitionExternalAllowed: true,
        },
        actor: "ws.observe_only",
        reason: input.reason,
        metadata: {
          ...(input.metadata ?? {}),
          authorityMode: "observe_only",
        },
      }))
      .catch((err) => console.error("[device-execution] observe-only WS JOB result telemetry failed:", (err as Error).message));
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
