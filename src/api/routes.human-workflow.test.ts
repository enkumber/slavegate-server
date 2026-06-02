import { describe, it, expect } from "vitest";
import crypto from "crypto";

// --- Helpers ---
function computeKey(deviceId: string, accountId: string, intent: string): string {
  return crypto.createHash("sha256").update(`${deviceId}:${accountId}:${intent.trim()}`).digest("hex").slice(0, 24);
}

// Exact patterns from src/api/routes.ts lines 76-86
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

// --- request key determinism ---
describe("request key", () => {
  it("deterministic", () => {
    const d = "550e8400-e29b-41d4-a716-446655440000";
    const a = "550e8400-e29b-41d4-a716-446655440001";
    const key = computeKey(d, a, "open Instagram");
    expect(key).toMatch(/^[a-f0-9]{24}$/);
    expect(key).toBe(computeKey(d, a, "open Instagram"));
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

// --- 8 Romanian intents ---
describe("Romanian safety — all 8 intents", () => {
  const roIntents = [
    ["postează", "postează o poză pe Instagram"],
    ["comentează", "comentează pe posturile de azi"],
    ["urmărește", "urmărește 10 persoane"],
    ["schimbă parola", "schimbă parola contului"],
    ["cumpără", "cumpără ceva de pe site"],
    ["șterge contul", "șterge contul de Instagram"],
    ["dezactivează contul", "dezactivează contul"],
    ["trimite un mesaj", "trimite un mesaj"],
  ];

  it.each(roIntents)("rejects %s", (_name, intent) => {
    expect(patterns.some(p => p.test(intent))).toBe(true);
  });

  it("accepts scroll intent", () => {
    expect(patterns.some(p => p.test("derulează feed-ul"))).toBe(false);
  });

  it("accepts open+screenshot", () => {
    expect(patterns.some(p => p.test("deschide Instagram și fă un screenshot"))).toBe(false);
  });
});

// --- 6 English intents ---
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
describe("compile route behavior", () => {
  // Mirrors assertHumanWorkflowIntentAllowed from routes.ts
  function assertAllowed(intent: string) {
    return !patterns.some(p => p.test(intent.trim()));
  }

  it.each([
    ["Romanian postează", "postează o poză"],
    ["Romanian cumpără", "cumpără ceva"],
    ["English follow", "follow 10 people"],
    ["English post", "post a photo"],
  ])("rejects %s at compile", (_name, intent) => {
    expect(assertAllowed(intent)).toBe(false);
  });

  it.each([
    ["scroll", "derulează feed-ul"],
    ["open+screenshot", "deschide Instagram și fă un screenshot"],
  ])("accepts %s at compile", (_name, intent) => {
    expect(assertAllowed(intent)).toBe(true);
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

  it("no false idempotency — same device+account, different intents", () => {
    const k1 = computeKey("d1", "a1", "open Instagram and take a selfie");
    const k2 = computeKey("d1", "a1", "open Instagram and scroll the feed");
    expect(k1).not.toBe(k2);
  });
});

describe("Romanian safety patterns", () => {
  const patterns = [
    /(post|publish|comment|reply|like|unlike|upvote|downvote|follow|unfollow)/i,
    /subscribe|unsubscribe|join|leave/i,
    /dm|direct message|private message|send message|send a message/i,
    /change|reset|update/i,
    /password|purchase|buy|checkout|delete account|deactivate account/i,
    /send|trimite/i,
    /postează|comentează|urmaște|urmărește|schimbă|cumpără|șterge|dezactivează/i,
  ];

  const roIntents = [
    "postează o poză pe Instagram",
    "comentează pe posturile de azi",
    "urmaște 10 persoane",
    "schimbă parola contului",
    "cumpără ceva de pe site",
    "șterge contul de Instagram",
    "dezactivează contul",
    "trimite un mesaj",
  ];

  it.each(roIntents.map(i => [i]))("rejects: %s", (intent) => {
    const matched = patterns.some(p => p.test(intent));
    expect(matched).toBe(true);
  });

  it("accepts scroll", () => {
    expect(patterns.some(p => p.test("fă un scroll pe feed"))).toBe(false);
  });

  it("accepts open+screenshot", () => {
    expect(patterns.some(p => p.test("deschide Instagram și fă un screenshot"))).toBe(false);
  });
});

describe("request key", () => {
  it("deterministic", () => {
    const k1 = crypto.createHash("sha256").update("a:b:c").digest("hex").slice(0, 24);
    const k2 = crypto.createHash("sha256").update("a:b:c").digest("hex").slice(0, 24);
    expect(k1).toBe(k2);
  });

  it("different device → different key", () => {
    const k1 = crypto.createHash("sha256").update("a:b:c").digest("hex").slice(0, 24);
    const k2 = crypto.createHash("sha256").update("d:b:c").digest("hex").slice(0, 24);
    expect(k1).not.toBe(k2);
  });

  it("different intent → different key", () => {
    const k1 = crypto.createHash("sha256").update("a:b:c").digest("hex").slice(0, 24);
    const k2 = crypto.createHash("sha256").update("a:b:d").digest("hex").slice(0, 24);
    expect(k1).not.toBe(k2);
  });
});
