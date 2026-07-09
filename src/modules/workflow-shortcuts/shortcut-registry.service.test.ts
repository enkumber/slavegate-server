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
      { type: "contains_all", terms: ["launch", "instagram"] },
      { type: "contains_all", terms: ["start", "instagram"] },
      { type: "contains_all", terms: ["porneste", "instagram"] },
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
    "open Instagram app",
    "launch Instagram",
    "deschide app Instagram",
    "porneste aplicatia Instagram",
  ])("matches open-app-only phrasing: %s", async (intent) => {
    const match = await shortcutRegistryService.lookupActiveShortcut({
      platform: "instagram",
      intent,
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

  it("does not classify subreddit navigation as a generic Reddit open-app shortcut", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [
        shortcutRow({
          key: "reddit_open_app",
          platform: "reddit",
          intent_patterns: [{ type: "contains_all", terms: ["deschide", "reddit"] }],
          match_config: {
            readOnlyOnly: true,
            rejectTerms: ["mergi pe", "askreddit", "/askreddit", "r/askreddit"],
          },
        }),
      ],
    });

    const match = await shortcutRegistryService.lookupActiveShortcut({
      platform: "reddit",
      intent: "deschide reddit si mergi pe /askreddit",
    });

    expect(match).toBeNull();
  });

  it("does not classify unknown follow-up work as open-app even without explicit reject terms", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [
        shortcutRow({
          key: "reddit_open_app",
          platform: "reddit",
          intent_patterns: [{ type: "contains_all", terms: ["deschide", "reddit"] }],
          match_config: { readOnlyOnly: true },
        }),
      ],
    });

    const match = await shortcutRegistryService.lookupActiveShortcut({
      platform: "reddit",
      intent: "deschide reddit si mergi la profilul meu",
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
      intent: "pe reddit, apasa butonul de comment la prima postare care apare in app",
      terms: ["reddit", "prima postare", "comment", "apasa"],
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

  it.each([
    "pe reddit, scrie un comment la prima postare care apare in app",
    "pe reddit, posteaza un comment la prima postare care apare in app",
    "pe reddit, apasa butonul de comment si scrie ceva la prima postare",
  ])("does not match mutating first-post comment-writing intents: %s", async (intent) => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [
        shortcutRow({
          key: "reddit_first_post_comments",
          platform: "reddit",
          intent_patterns: [{ type: "contains_all", terms: ["reddit", "prima postare", "comment"] }],
          match_config: { readOnlyOnly: true },
        }),
      ],
    });

    const match = await shortcutRegistryService.lookupActiveShortcut({
      platform: "reddit",
      intent,
    });

    expect(match).toBeNull();
  });
});
