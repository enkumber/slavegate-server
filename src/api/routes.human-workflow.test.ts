import { describe, expect, it } from "vitest";
import {
  computeHumanWorkflowRequestKey,
  humanWorkflowArtifactMatchesIntent,
} from "../modules/human-workflow/human-workflow-compiler.service";
import {
  resolveCompositionInputs,
  validateInputResolver,
} from "../modules/workflow-segments/input-resolver";
import { computeExecutionKey } from "../modules/workflow-segments/key-utils";
import { evaluatePostconditionContract } from "../modules/workflow-segments/postcondition";
import {
  requireHumanRunIdempotencyKey,
  resolveHumanRunIdempotencyKey,
} from "../modules/human-workflow/run-idempotency-policy";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

describe("dashboard human workflow integrity contract", () => {
  it("uses the exact device, account and intent for request identity", () => {
    const first = computeHumanWorkflowRequestKey(DEVICE_ID, ACCOUNT_ID, "open example one");
    const same = computeHumanWorkflowRequestKey(DEVICE_ID, ACCOUNT_ID, "open example one");
    const differentInput = computeHumanWorkflowRequestKey(DEVICE_ID, ACCOUNT_ID, "open example two");

    expect(first).toBe(same);
    expect(first).not.toBe(differentInput);
    expect(first).toMatch(/^[a-f0-9]{24}$/);
  });

  it("does not accept a complete legacy artifact for another concrete intent", () => {
    const artifact = {
      requestKey: computeHumanWorkflowRequestKey(DEVICE_ID, ACCOUNT_ID, "open example one"),
      sourceMetadata: {
        source: "dashboard_human",
        intent: "open example one",
        outputContractVersion: "required-v1",
      },
      workflow: {
        id: "legacy_complete_artifact",
        version: "1.0.0",
        platform: "sample",
        safetyClass: "read_only",
        steps: [],
      },
    };

    expect(humanWorkflowArtifactMatchesIntent(
      artifact as never,
      "open example one",
    )).toBe(true);
    expect(humanWorkflowArtifactMatchesIntent(
      artifact as never,
      "open example two",
    )).toBe(false);
  });

  it("fails closed when a segment input is absent or invalid", () => {
    const schema = {
      type: "object" as const,
      required: ["target"],
      additionalProperties: false,
      properties: {
        target: { type: "string" as const, format: "uri" as const, minLength: 1 },
      },
    };

    const missingResolver = {
      version: "1" as const,
      fields: {},
    };
    expect(() => validateInputResolver(missingResolver, schema)).toThrow(/missing required field/);
    expect(() => resolveCompositionInputs("open not a uri", {
      version: "1",
      fields: {
        target: {
          sources: [{ kind: "regex", pattern: "open (.+)", group: 1 }],
        },
      },
    }, schema)).toThrow(/schema validation/);
    expect(resolveCompositionInputs("open https://example.test", {
      version: "1",
      fields: {
        target: {
          sources: [{ kind: "regex", pattern: "open (.+)", group: 1 }],
        },
      },
    }, schema)).toEqual({ target: "https://example.test" });
  });

  it("requires a data-defined resolver and verifies output against runtime input", () => {
    const resolver = {
      version: "1" as const,
      fields: {
        target: {
          sources: [{
            kind: "regex" as const,
            pattern: "(https?://[^\\s]+)",
            flags: "i",
            group: 1,
          }],
        },
      },
    };
    expect(() => validateInputResolver(resolver, {
      type: "object",
      required: ["target"],
      properties: { target: { type: "string", format: "uri" } },
    })).not.toThrow();

    const contract = {
      version: "1" as const,
      all: [
        { left: { path: "outputs.navigationResult.launched" }, operator: "truthy" as const, operatorOpcode: 0 },
        {
          left: { path: "outputs.navigationResult.observedUri" },
          operator: "uri_equivalent" as const,
          operatorOpcode: 11,
          right: { path: "inputs.target" },
        },
      ],
    };
    expect(evaluatePostconditionContract(contract, {
      outputs: {
        navigationResult: {
          launched: true,
          observedUri: "https://example.test/",
        },
      },
      inputs: { target: "https://example.test" },
    })).toMatchObject({ ok: true });
    expect(evaluatePostconditionContract(contract, {
      outputs: {
        navigationResult: {
          launched: true,
          observedUri: "https://wrong.example/",
        },
      },
      inputs: { target: "https://example.test" },
    })).toMatchObject({ ok: false });
  });

  it("rejects structural presence-only postconditions as business proof", () => {
    const contract = {
      version: "1" as const,
      all: [
        { left: { path: "outputs.loggedIn" }, operator: "present" as const, operatorOpcode: 8 },
        { left: { path: "outputs.screenState" }, operator: "present" as const, operatorOpcode: 8 },
      ],
    };

    expect(evaluatePostconditionContract(contract, {
      outputs: {
        loggedIn: false,
        homeFeedVisible: false,
        searchSurfaceAvailable: false,
        screenState: "not_reddit",
      },
    })).toMatchObject({
      ok: false,
      failures: expect.arrayContaining(["postcondition contract contains no positive business proof"]),
    });
  });

  it("uses PostgreSQL policy to choose fresh human run idempotency", async () => {
    const db = {
      query: async () => ({
        rows: [{
          policy: {
            humanWorkflowRun: {
              freshRunIdempotencyByDefault: true,
            },
          },
        }],
      }),
    };

    await expect(resolveHumanRunIdempotencyKey({
      generatedFreshKey: "fresh-key",
      db: db as never,
    })).resolves.toBe("fresh-key");
    expect(requireHumanRunIdempotencyKey("caller-key")).toBe("caller-key");
  });

  it("refuses replay-only human runs before dispatch when policy requires explicit identity", async () => {
    const db = {
      query: async () => ({
        rows: [{
          policy: {
            humanWorkflowRun: {
              replayOnlyWithoutIdempotencyKey: true,
            },
          },
        }],
      }),
    };

    await expect(resolveHumanRunIdempotencyKey({
      generatedFreshKey: "fresh-key",
      db: db as never,
    })).rejects.toMatchObject({ code: "WORKFLOW_IDEMPOTENCY_REPLAY_ONLY" });
  });

  it("documents the structural execution-key boundary independently of request text hashing", () => {
    const executionKey = computeExecutionKey({
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_ID,
      compositionKey: "composition-structure",
      runtimeInputs: { target: "https://example.test" },
    });
    expect(executionKey).toMatch(/^[a-f0-9]{24}$/);
  });
});
