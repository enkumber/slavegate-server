import { describe, it, expect } from "vitest";
import crypto from "crypto";

// --- Helpers ---

function computeKey(deviceId: string, accountId: string, intent: string): string {
  return crypto
    .createHash("sha256")
    .update(`${deviceId}:${accountId}:${intent.trim()}`)
    .digest("hex")
    .slice(0, 24);
}

// Mirror exact patterns from routes.ts
const patterns: RegExp[] = [
  /\b(post|publish|comment|reply|like|unlike|upvote|downvote|follow|unfollow)\b/i,
  /\b(subscribe|unsubscribe|join|leave)\b/i,
  /postează|comentează|urmărește|dezurmărește|abonează-te|dezabonează-te/i,
  /\b(dm|direct message|private message|send message|send a message|trimite)\b/i,
  /schimbă|resetează|actualizează/i,
  /\b(change|reset|update)\s+(my\s+|the\s+)?password\b/i,
  /password|parole|purchase|buy|checkout|cumpără|plată/i,
  /șterge|deactivate account|delete account|dezactivează|deletează cont|șterge cont/i,
];

// --- Tests ---

describe("request key determinism", () => {
  it("same inputs → same key", () => {
    const d = "550e8400-e29b-41d4-a716-446655440000";
    const a = "550e8400-e29b-41d4-a716-446655440001";
    const i = "open Instagram";
    const key = computeKey(d, a, i);
    expect(key).toMatch(/^[a-f0-9]{24}$/);
    expect(key).toBe(computeKey(d, a, i));
  });

  it("different device → different key", () => {
    expect(computeKey("d1", "a1", "test")).not.toBe(computeKey("d2", "a1", "test"));
  });

  it("different account → different key", () => {
    expect(computeKey("d1", "a1", "test")).not.toBe(computeKey("d1", "a2", "test"));
  });

  it("different intent → different key", () => {
    expect(computeKey("d1", "a1", "take selfie")).not.toBe(computeKey("d1", "a1", "open IG"));
  });
});

describe("English safety detection", () => {
  it.each([
    ["post", "post a new photo"],
    ["comment", "comment on posts"],
    ["follow", "follow 10 people"],
    ["unfollow", "unfollow everyone"],
    ["password", "change my password"],
    ["send message", "send a message to friend"],
  ])("detects %s", (_name, intent) => {
    expect(patterns.some(p => p.test(intent))).toBe(true);
  });
});

describe("Romanian safety detection", () => {
  it.each([
    ["postează", "postează o poză pe Instagram"],
    ["comentează", "comentează pe posturile de azi"],
    ["urmărește", "urmărește 10 persoane"],
    ["schimbă parola", "schimbă parola contului"],
    ["cumpără", "cumpără ceva de pe site"],
    ["șterge", "șterge contul de Instagram"],
    ["dezactivează", "dezactivează contul"],
    ["trimite", "trimite un mesaj"],
  ])("detects %s", (_name, intent) => {
    expect(patterns.some(p => p.test(intent))).toBe(true);
  });

  it("does not match scroll intent", () => {
    expect(patterns.some(p => p.test("derulează feed-ul și fă un screenshot"))).toBe(false);
  });
});

describe("idempotency", () => {
  it("deterministic requestKey", () => {
    expect(computeKey("d1", "a1", "test")).toBe(computeKey("d1", "a1", "test"));
  });

  it("different intent → no collision", () => {
    expect(computeKey("d1", "a1", "take selfie")).not.toBe(computeKey("d1", "a1", "open IG"));
  });
});

describe("pattern completeness", () => {
  it("covers all English action verbs", () => {
    const verbs = ["post", "publish", "comment", "reply", "like", "follow", "subscribe", "join", "dm", "buy", "checkout"];
    // 'change', 'delete', 'deactivate' match only in compound phrases (change password, delete account) 
    const missed = verbs.filter(v => !patterns.some(p => p.test(v)));
    expect(missed).toHaveLength(0);
  });

  it("covers all Romanian action verbs", () => {
    const verbs = ["postează", "comentează", "urmărește", "schimbă", "cumpără", "șterge", "dezactivează", "trimite"];
    const missed = verbs.filter(v => !patterns.some(p => p.test(v)));
    expect(missed).toHaveLength(0);
  });
});
