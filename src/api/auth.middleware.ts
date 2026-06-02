import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getDb } from "../db/client";

const MONITORING_TOKEN_PURPOSES = new Set(["openclaw_agent", "monitoring", "admin"]);
const ADMIN_TOKEN_PURPOSES = new Set(["admin"]);

export type AuthPrincipal =
  | { kind: "global_api_key"; scopes: ["admin"] }
  | { kind: "dashboard_jwt"; userId: string; scopes: ["admin"]; payload: Record<string, unknown> }
  | { kind: "api_token"; purpose: "openclaw_agent" | "monitoring" | "admin"; scopes: string[]; tokenId: string };

type ApiTokenPurpose = "openclaw_agent" | "monitoring" | "admin";

const MONITORING_READ_ROUTES = new Set([
  "GET /devices",
  "GET /debug/connections",
  "GET /scalability/status",
  "GET /health",
]);

function isApiTokenPurpose(purpose: unknown): purpose is ApiTokenPurpose {
  return typeof purpose === "string" && MONITORING_TOKEN_PURPOSES.has(purpose);
}

function setPrincipal(req: Request, principal: AuthPrincipal): void {
  (req as any).authPrincipal = principal;
  if (principal.kind === "dashboard_jwt") {
    (req as any).dashboardUser = principal.payload;
  }
}

function scopesForPurpose(purpose: ApiTokenPurpose): string[] {
  if (purpose === "admin") return ["admin"];
  if (purpose === "openclaw_agent") return ["monitoring:read", "devices:read"];
  return ["monitoring:read"];
}

function hasAdminAccess(principal: AuthPrincipal): boolean {
  if (principal.kind === "api_token") return ADMIN_TOKEN_PURPOSES.has(principal.purpose);
  return principal.scopes.includes("admin");
}

function hasMonitoringAccess(principal: AuthPrincipal): boolean {
  if (principal.kind !== "api_token") return true;
  return MONITORING_TOKEN_PURPOSES.has(principal.purpose);
}

function isMonitoringReadRoute(req: Request): boolean {
  return MONITORING_READ_ROUTES.has(`${req.method.toUpperCase()} ${req.path}`);
}

function unauthorized(res: Response): void {
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

function forbidden(res: Response): void {
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

// JWT_SECRET must be set — no fallback to API_KEY (which is short/guessable).
// Validated at startup (requiredEnv check in index.ts).
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set — server should have refused to start");
  return secret;
}

export function signJwt(payload: Record<string, unknown>, expiresInMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor((Date.now() + expiresInMs) / 1000), iat: Math.floor(Date.now() / 1000) })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getJwtSecret())
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return null;
    const expectedSig = crypto
      .createHmac("sha256", getJwtSecret())
      .update(`${header}.${body}`)
      .digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function verifyApiToken(token: string): Promise<AuthPrincipal | null> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const db = getDb();
  const result = await db.query(
    `SELECT id, purpose, expires_at, revoked_at FROM api_tokens WHERE token_hash = $1`,
    [tokenHash]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  if (row.revoked_at || new Date(row.expires_at) <= new Date()) return null;
  if (!isApiTokenPurpose(row.purpose)) return null;

  return {
    kind: "api_token",
    purpose: row.purpose,
    scopes: scopesForPurpose(row.purpose),
    tokenId: row.id,
  };
}

export async function authenticateRequest(req: Request): Promise<AuthPrincipal | null> {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey && apiKey === process.env.API_KEY) {
    return { kind: "global_api_key", scopes: ["admin"] };
  }

  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const jwtPayload = verifyJwt(token);
    if (jwtPayload) {
      return {
        kind: "dashboard_jwt",
        userId: typeof jwtPayload.sub === "string" ? jwtPayload.sub : "dashboard",
        scopes: ["admin"],
        payload: jwtPayload,
      };
    }
    return verifyApiToken(token);
  }

  const deviceToken = req.headers["x-device-token"];
  if (typeof deviceToken === "string" && deviceToken) {
    return verifyApiToken(deviceToken);
  }

  return null;
}

export async function requireAdminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const principal = await authenticateRequest(req);
    if (!principal) return unauthorized(res);
    if (!hasAdminAccess(principal)) return forbidden(res);
    setPrincipal(req, principal);
    next();
  } catch {
    unauthorized(res);
  }
}

export async function requireMonitoringAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const principal = await authenticateRequest(req);
    if (!principal) return unauthorized(res);
    if (!hasMonitoringAccess(principal)) return forbidden(res);
    setPrincipal(req, principal);
    next();
  } catch {
    unauthorized(res);
  }
}

export function requireApiGateAuth(req: Request, res: Response, next: NextFunction): void {
  if (isMonitoringReadRoute(req)) {
    void requireMonitoringAuth(req, res, next);
    return;
  }
  void requireAdminAuth(req, res, next);
}
