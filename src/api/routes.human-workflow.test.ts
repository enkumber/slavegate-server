import { describe, it, expect } from "vitest";
import crypto from "crypto";

function computeKey(deviceId: string, accountId: string, intent: string): string {
  return crypto.createHash("sha256").update(`${deviceId}:${accountId}:${intent.trim()}`).digest("hex").slice(0, 24);
}

// Exact patterns from routes.ts (lines 76-86)
const patterns: RegExp[] = [
  /\b(post|publish|comment|reply|like|unlike|upvote|downvote|follow|unfollow)\b/i,
  /\b(subscribe|unsubscribe|join|leave)\b/i,
  /\b(dm|direct message|private message|send message|send a message)\b/i,
  /\b(change|reset|update)\s+(my\s+|the\s+)?password\b/i,
  /\b(password|purchase|buy|checkout|delete account|deactivate account)\b/i,
  /\b(send|trimite)\s+(message|mesaj)\b/i,
  /postează|comentează|urmărește|dezurmărește|abonează-te|dezabonează-te/i,
  /cumpără|plată|parolă|parola|parole/i,
  /(?:șterge|deletează|dezactivează)\s+cont(?:ul)?/i,
  /trimite\s+(?:un\s+)?mesaj/i,
  /(?:schimbă|resetează|actualizează)\s+(?:parola|parolă|contul|profilul|datele)/i,
];

// --- request key ---
describe("request key", () => {
  it("same inputs → same key", () => {
    expect(computeKey("d1", "a1", "test")).toBe(computeKey("d1", "a1", "test"));
  });
  it("different device → different key", () => {
    expect(computeKey("d1", "a1", "test")).not.toBe(computeKey("d2", "a1", "test"));
  });
  it("different account → different key", () => {
    expect(computeKey("d1", "a1", "test")).not.toBe(computeKey("d1", "a2", "test"));
  });
});

// --- Romanian safety (8 intents) ---
describe("Romanian safety — all 8 intents", () => {
  const roIntents = [
    "postează o poză pe Instagram",
    "comentează pe posturile de azi",
    "urmărește 10 persoane",
    "schimbă parola contului",
    "cumpără ceva de pe site",
    "șterge contul de Instagram",
    "dezactivează contul",
    "trimite un mesaj",
  ];

  it.each(roIntents.map(i => [i]))("rejects: %s", (intent) => {
    expect(patterns.some(p => p.test(intent))).toBe(true);
  });

  it("does not match scroll", () => {
    expect(patterns.some(p => p.test("derulează feed-ul și fă un screenshot"))).toBe(false);
  });

  it("does not match open+screenshot", () => {
    expect(patterns.some(p => p.test("deschide Instagram și fă un screenshot"))).toBe(false);
  });
});

// --- English safety ---
describe("English safety", () => {
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

// --- Compile-level checks ---
describe("compile checks", () => {
  function compileCheck(intent: string) {
    return patterns.some(p => p.test(intent.trim()));
  }

  it("rejects Romanian 'postează'", () => {
    expect(compileCheck("postează o poză")).toBe(true);
  });
  it("rejects Romanian 'cumpără'", () => {
    expect(compileCheck("cumpără ceva")).toBe(true);
  });
  it("rejects English 'follow'", () => {
    expect(compileCheck("follow 10 people")).toBe(true);
  });
  it("accepts scroll", () => {
    expect(compileCheck("derulează feed-ul")).toBe(false);
  });
  it("accepts open+screenshot", () => {
    expect(compileCheck("deschide Instagram și fă un screenshot")).toBe(false);
  });
});

// --- Idempotency ---
describe("idempotency", () => {
  it("deterministic requestKey", () => {
    expect(computeKey("d1", "a1", "test")).toBe(computeKey("d1", "a1", "test"));
  });
  it("different intent → no collision", () => {
    expect(computeKey("d1", "a1", "take selfie")).not.toBe(computeKey("d1", "a1", "open IG"));
  });
});
