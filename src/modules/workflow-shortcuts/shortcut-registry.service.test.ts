import { beforeEach, describe, expect, it, vi } from "vitest";
import { shortcutRegistryService } from "./shortcut-registry.service";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

function shortcutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    key: "instagram_open_app",
    platform: "instagram",
    name: "Open instagram app",
    description: "Open the app and wait briefly.",
    status: "active",
    priority: 100,
    intent_patterns: [
      { type: "contains_all", terms: ["deschide", "instagram"] },
      { type: "contains_all", terms: ["open", "instagram"] },
    ],
    aliases: [],
    match_config: {
      readOnlyOnly: true,
      rejectTerms: ["screenshot", "citeste", "notificari", "scroll", "apasa", "tap"],
    },
    workflow_template: {
      id: "dashboard_human_instagram_open_app_v1",
      name: "Open instagram app",
      platform: "instagram",
      version: "1.0.0",
      steps: [],
    },
    compatibility: {},
    metadata: {},
    usage_count: 0,
    success_count: 0,
    failure_count: 0,
    last_used_at: null,
    ...overrides,
  };
}

describe("shortcutRegistryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.query.mockResolvedValue({ rows: [shortcutRow()] });
  });

  it("matches explicit open-app intents", async () => {
    const match = await shortcutRegistryService.lookupActiveShortcut({
      platform: "instagram",
      intent: "deschide Instagram",
    });

    expect(match?.shortcut.key).toBe("instagram_open_app");
  });

  it.each([
    "deschide Instagram si fa screenshot",
    "deschide Instagram si citeste notificarile",
    "open Instagram and scroll the feed",
    "deschide Instagram si apasa pe primul buton",
  ])("does not match open-app shortcut when the intent has follow-up work: %s", async (intent) => {
    const match = await shortcutRegistryService.lookupActiveShortcut({
      platform: "instagram",
      intent,
    });

    expect(match).toBeNull();
  });

  it.each([
    "schimba parola contului de Instagram",
    "dezactiveaza contul de Instagram",
    "dezurmareste contul acesta pe Instagram",
    "trimite mesaj pe Instagram",
  ])("does not match read-only shortcuts for account-changing Romanian intents: %s", async (intent) => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [
        shortcutRow({
          intent_patterns: [{ type: "contains_all", terms: ["instagram"] }],
          match_config: { readOnlyOnly: true },
        }),
      ],
    });

    const match = await shortcutRegistryService.lookupActiveShortcut({
      platform: "instagram",
      intent,
    });

    expect(match).toBeNull();
  });

  it.each([
    {
      intent: "intra pe reddit si apasa pe butonul de comentarii de primul post",
      terms: ["reddit", "primul post", "comentarii", "apasa"],
    },
    {
      intent: "tap the comments button on the first post on reddit",
      terms: ["reddit", "first post", "comments", "tap"],
    },
  ])("allows read-only first-post navigation shortcuts: $intent", async ({ intent, terms }) => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [
        shortcutRow({
          key: "reddit_first_post_comments",
          platform: "reddit",
          intent_patterns: [{ type: "contains_all", terms }],
          match_config: { readOnlyOnly: true },
        }),
      ],
    });

    const match = await shortcutRegistryService.lookupActiveShortcut({
      platform: "reddit",
      intent,
    });

    expect(match?.shortcut.key).toBe("reddit_first_post_comments");
  });
});
