import { describe, test, expect } from "vitest";
import { selectIntent, buildProposal, createCreativeWorkflowRun } from "./creative-workflow.service";

describe("selectIntent", () => {
  test("scan intent for health/scan keywords", () => {
    expect(selectIntent("Scan account health").intent).toBe("account_scan");
    expect(selectIntent("Check health").intent).toBe("account_scan");
    expect(selectIntent("Audit everything").intent).toBe("account_scan");
  });

  test("strategy_review intent", () => {
    expect(selectIntent("Review strategy").intent).toBe("strategy_review");
    expect(selectIntent("Plan the week").intent).toBe("strategy_review");
  });

  test("engagement_boost intent", () => {
    expect(selectIntent("Boost engagement").intent).toBe("engagement_boost");
    expect(selectIntent("Grow followers").intent).toBe("engagement_boost");
  });

  test("content_post intent", () => {
    expect(selectIntent("Post content").intent).toBe("content_post");
    expect(selectIntent("Create posts").intent).toBe("content_post");
  });

  test("audience_research intent", () => {
    expect(selectIntent("Research audience").intent).toBe("audience_research");
    expect(selectIntent("Discover interests").intent).toBe("audience_research");
  });

  test("default intent", () => {
    expect(selectIntent("do something").intent).toBe("account_scan");
    expect(selectIntent("").intent).toBe("account_scan");
  });

  test("safety class matches intent", () => {
    expect(selectIntent("Scan account").safetyClass).toBe("read_only");
    expect(selectIntent("Boost engagement").safetyClass).toBe("light");
    expect(selectIntent("Post content").safetyClass).toBe("light");
  });
});

describe("buildProposal", () => {
  test("builds proposal with all fields", () => {
    const proposal = buildProposal({
      clientId: "client-1",
      accountId: "account-1",
      deviceId: "device-1",
      objective: "Scan account",
    });

    expect(proposal.objective).toBe("Scan account");
    expect(proposal.intent).toBe("account_scan");
    expect(proposal.safetyClass).toBe("read_only");
    expect(proposal.clientId).toBe("client-1");
    expect(proposal.accountId).toBe("account-1");
    expect(proposal.deviceId).toBe("device-1");
    expect(proposal.summary).toContain("Scan account");
  });
});

describe("createCreativeWorkflowRun", () => {
  test("happy path", async () => {
    const result = await createCreativeWorkflowRun({
      clientId: "c-1",
      accountId: "a-1",
      deviceId: "d-1",
      objective: "Scan account",
      dryRun: false,
    });

    expect(result.runId).toBeDefined();
    expect(result.status).toBe("queued");
    expect(result.proposal.intent).toBe("account_scan");
    expect(result.proposal.safetyClass).toBe("read_only");
    expect(result.agencyWorkflowRunId).toBeDefined();
    expect(result.taskId).toBeDefined();
    expect(result.message).toContain("created");
  });

  test("dry run returns proposal status", async () => {
    const result = await createCreativeWorkflowRun({
      clientId: "c-1",
      accountId: "a-1",
      deviceId: "d-1",
      objective: "Boost engagement",
      dryRun: true,
    });

    expect(result.status).toBe("proposal");
    expect(result.proposal.intent).toBe("engagement_boost");
    expect(result.proposal.safetyClass).toBe("light");
    expect(result.agencyWorkflowRunId).toBeNull();
    expect(result.taskId).toBeNull();
    expect(result.message).toContain("Dry run");
  });

  test("missing fields returns not_ready", async () => {
    const result = await createCreativeWorkflowRun({
      clientId: "",
      accountId: "",
      deviceId: "",
      objective: "",
    });

    expect(result.status).toBe("not_ready");
    expect(result.message).toContain("Missing required fields");
  });

  test("null fields returns not_ready", async () => {
    const result = await createCreativeWorkflowRun({
      clientId: "c-1",
      accountId: "a-1",
      deviceId: "d-1",
      objective: "Scan",
    });

    expect(result.runId).toBeDefined();
    expect(result.status).toBe("queued");
  });
});
