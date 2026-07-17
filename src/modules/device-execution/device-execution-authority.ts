export type DeviceExecutionAuthorityMode = "observe_only" | "enforced";

/**
 * PNQ-003 Phase 1 authority contract.
 *
 * Keep PNQ persistence/telemetry available, but remove it as a production
 * lifecycle authority coherently. Re-enforcement is deliberately a code/release
 * decision, not an environment toggle that could split processes at runtime.
 */
export const DEVICE_EXECUTION_AUTHORITY = Object.freeze({
  mode: "observe_only" as DeviceExecutionAuthorityMode,
  admission: false,
  egressPermits: false,
  ingressGating: false,
  timeoutEnforcement: false,
  startupReconciliation: false,
  cancellationAuthority: false,
  telemetry: true,
});

let testMode: DeviceExecutionAuthorityMode | null = null;

export function setDeviceExecutionAuthorityForTest(mode: DeviceExecutionAuthorityMode | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Device execution authority test override is test-only");
  testMode = mode;
}

export function isDeviceExecutionEnforced(): boolean {
  return (testMode ?? (process.env.NODE_ENV === "test" ? "enforced" : DEVICE_EXECUTION_AUTHORITY.mode)) === "enforced";
}
