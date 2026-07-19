import { describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../workflows/types";
import { parseDeviceStepResults, validateRequiredDeviceStepResults } from "./task-runner.service";

const workflow: WorkflowTemplate = {
  id: "verified-workflow",
  name: "Verified workflow",
  platform: "android",
  description: "Local verification fixture",
  version: "1.0.0",
  defaultVerificationStrategy: "local_only",
  dataRetentionDays: 7,
  steps: [{
    id: "unlock",
    type: "action",
    action: "unlock",
    deviceVerification: {
      required: true,
      postconditions: [{ path: "keyguard.locked", expected: false }],
    },
  }],
};

describe("device step result gate", () => {
  it("accepts a required step only when the device verified it", () => {
    const results = parseDeviceStepResults({
      _stepResults: [{
        stepId: "unlock",
        action: "unlock",
        status: "verified",
        deviceVerified: true,
        verificationVersion: "device-step-verification/v1",
      }],
    });
    expect(validateRequiredDeviceStepResults(workflow, results)).toBeNull();
  });

  it("rejects global completion without the required device result", () => {
    expect(validateRequiredDeviceStepResults(workflow, [])).toBe(
      "DEVICE_STEP_VERIFICATION_MISSING: unlock has no verified device result",
    );
  });

  it("propagates a device-local verification failure", () => {
    const results = parseDeviceStepResults({
      _stepResults: [{
        stepId: "unlock",
        status: "failed",
        deviceVerified: false,
        errorCode: "DEVICE_POSTCONDITION_FAILED",
      }],
    });
    expect(validateRequiredDeviceStepResults(workflow, results)).toBe(
      "DEVICE_POSTCONDITION_FAILED: unlock was rejected by the device",
    );
  });
});
