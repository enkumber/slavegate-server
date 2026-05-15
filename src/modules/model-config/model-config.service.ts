/**
 * Server-side model/token configuration for Phone Network.
 * DB rows are primary. Env is only an explicit credential ref or bootstrap fallback
 * when DB rows are absent. API responses are always redacted.
 */

import crypto from "crypto";
import fs from "fs/promises";
import { getDb } from "../../db/client";

export type ModelRole = "decision_llm" | "vision_vlm";

export interface ModelConfig {
  role: ModelRole;
  provider: string;
  endpoint: string | null;
  model: string;
  apiKeyEncrypted: string | null;
  credentialRef: string | null;
  apiKeyFingerprint: string | null;
  enabled: boolean;
  version: number;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RedactedModelConfig extends Omit<ModelConfig, "apiKeyEncrypted" | "credentialRef"> {
  hasCredential: boolean;
  credential: "redacted" | null;
  credentialConfigured: boolean;
  credentialRefType: "db-secret" | "env" | "file" | null;
  lastFour: string | null;
  versionHash: string;
}

export interface DeviceModelConfigRole {
  provider: string;
  endpoint: string | null;
  model: string;
  apiKey: string;
  version: number;
  versionHash: string;
}

export interface DeviceModelConfigBundle {
  deliveryMode: "direct_to_device";
  ttlSeconds: number;
  expiresAt: string;
  roles: Record<ModelRole, DeviceModelConfigRole>;
}

interface UpdateModelConfigInput {
  provider?: string;
  endpoint?: string | null;
  model?: string;
  enabled?: boolean;
  credentialRef?: string | null;
}

interface CredentialInput {
  credential?: string;
  apiKey?: string;
  credentialRef?: string | null;
}

interface ResolvedModelConfig extends ModelConfig {
  apiKey: string;
}

const ROLES: ModelRole[] = ["decision_llm", "vision_vlm"];
const CACHE_TTL_MS = 30_000;

export class ModelConfigError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode = 400, code = "AI_MODEL_CONFIG_ERROR") {
    super(message);
    this.name = "ModelConfigError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ModelConfigService {
  private cache = new Map<ModelRole, { config: ModelConfig; expiresAt: number }>();

  async list(): Promise<RedactedModelConfig[]> {
    const rows = await this.queryRows("SELECT * FROM model_configs ORDER BY role");
    return rows.map((row) => this.redact(this.fromRow(row)));
  }

  async get(role: ModelRole): Promise<RedactedModelConfig | null> {
    const config = await this.getRaw(role);
    return config ? this.redact(config) : null;
  }

  async update(role: ModelRole, input: UpdateModelConfigInput): Promise<RedactedModelConfig> {
    assertRole(role);
    const existing = await this.getRaw(role);
    const provider = normalizeNonEmpty(input.provider ?? existing?.provider ?? defaultFor(role).provider, "provider");
    const model = normalizeNonEmpty(input.model ?? existing?.model ?? defaultFor(role).model, "model");
    const endpoint = input.endpoint !== undefined ? nullableString(input.endpoint) : existing?.endpoint ?? defaultFor(role).endpoint;
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : existing?.enabled ?? false;
    const credentialRef = input.credentialRef !== undefined ? validateCredentialRef(nullableString(input.credentialRef)) : existing?.credentialRef ?? null;

    const result = await getDb().query(
      `INSERT INTO model_configs
         (role, provider, endpoint, model, api_key_encrypted, credential_ref, api_key_fingerprint, enabled, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
       ON CONFLICT (role) DO UPDATE SET
         provider = EXCLUDED.provider,
         endpoint = EXCLUDED.endpoint,
         model = EXCLUDED.model,
         credential_ref = EXCLUDED.credential_ref,
         enabled = EXCLUDED.enabled,
         version = model_configs.version + 1,
         updated_at = NOW()
       RETURNING *`,
      [role, provider, endpoint, model, existing?.apiKeyEncrypted ?? null, credentialRef, existing?.apiKeyFingerprint ?? null, enabled]
    );
    this.invalidate(role);
    return this.redact(this.fromRow(result.rows[0]));
  }

  async updateCredential(role: ModelRole, input: CredentialInput): Promise<RedactedModelConfig> {
    assertRole(role);
    const existing = await this.getRaw(role);
    if (!existing) throw new ModelConfigError(`Model config for ${role} is missing`, 404, "AI_MODEL_CONFIG_MISSING");

    const rawCredential = input.credential ?? input.apiKey;
    const credentialRef = input.credentialRef !== undefined ? validateCredentialRef(nullableString(input.credentialRef)) : undefined;
    let apiKeyEncrypted = existing.apiKeyEncrypted;
    let apiKeyFingerprint = existing.apiKeyFingerprint;
    let nextCredentialRef = existing.credentialRef;

    if (rawCredential !== undefined && rawCredential !== "") {
      apiKeyEncrypted = encryptDbSecret(rawCredential);
      apiKeyFingerprint = fingerprint(rawCredential);
      nextCredentialRef = null;
    } else if (credentialRef !== undefined) {
      apiKeyEncrypted = null;
      apiKeyFingerprint = null;
      nextCredentialRef = credentialRef;
    } else {
      throw new ModelConfigError("credential or credentialRef is required", 400, "AI_CREDENTIAL_MISSING");
    }

    const result = await getDb().query(
      `UPDATE model_configs
       SET api_key_encrypted = $2,
           credential_ref = $3,
           api_key_fingerprint = $4,
           version = version + 1,
           updated_at = NOW()
       WHERE role = $1
       RETURNING *`,
      [role, apiKeyEncrypted, nextCredentialRef, apiKeyFingerprint]
    );
    this.invalidate(role);
    return this.redact(this.fromRow(result.rows[0]));
  }

  async resolve(role: ModelRole): Promise<ResolvedModelConfig> {
    const config = await this.getRaw(role) ?? this.envFallback(role);
    if (!config) throw new ModelConfigError(`Model config for ${role} is missing. Configure it in Dashboard → Tokens / Models.`, 503, "AI_MODEL_CONFIG_MISSING");
    if (!config.enabled) throw new ModelConfigError(`Model config for ${role} is disabled. Enable it in Dashboard → Tokens / Models.`, 503, "AI_MODEL_DISABLED");
    const apiKey = await this.resolveCredential(config);
    if (!apiKey) throw new ModelConfigError(`Model config for ${role} has no server-side credential. Add a credential via Dashboard → Tokens / Models.`, 503, "AI_CREDENTIAL_MISSING");
    return { ...config, apiKey };
  }

  async getDeviceBundle(ttlSeconds = deviceConfigTtlSeconds()): Promise<DeviceModelConfigBundle> {
    const roles = {} as Record<ModelRole, DeviceModelConfigRole>;
    for (const role of ROLES) {
      const config = await this.resolve(role);
      roles[role] = {
        provider: config.provider,
        endpoint: endpointBase(config.endpoint, config.provider),
        model: config.model,
        apiKey: config.apiKey,
        version: config.version,
        versionHash: versionHash(config),
      };
    }
    return {
      deliveryMode: "direct_to_device",
      ttlSeconds,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      roles,
    };
  }

  async test(role: ModelRole): Promise<RedactedModelConfig> {
    const started = Date.now();
    try {
      const config = await this.resolve(role);
      await testProvider(config);
      return await this.storeTest(role, "ok", `Connection OK (${Date.now() - started}ms)`);
    } catch (err) {
      const message = (err as Error).message;
      await this.storeTest(role, "error", message).catch(() => undefined);
      throw new ModelConfigError(message, err instanceof ModelConfigError ? err.statusCode : 502, err instanceof ModelConfigError ? err.code : "AI_PROVIDER_TEST_FAILED");
    }
  }

  invalidate(role?: ModelRole): void {
    if (role) this.cache.delete(role);
    else this.cache.clear();
  }

  private async getRaw(role: ModelRole): Promise<ModelConfig | null> {
    assertRole(role);
    const cached = this.cache.get(role);
    if (cached && cached.expiresAt > Date.now()) return cached.config;
    const rows = await this.queryRows("SELECT * FROM model_configs WHERE role = $1", [role]);
    if (!rows[0]) return null;
    const config = this.fromRow(rows[0]);
    this.cache.set(role, { config, expiresAt: Date.now() + CACHE_TTL_MS });
    return config;
  }

  private async queryRows(sql: string, params: unknown[] = []): Promise<any[]> {
    try {
      const result = await getDb().query(sql, params);
      return result.rows;
    } catch (err: any) {
      if (err.code === "42P01") throw new ModelConfigError("model_configs table is missing. Run database migrations.", 503, "AI_MODEL_CONFIG_MISSING");
      throw err;
    }
  }

  private fromRow(row: any): ModelConfig {
    return {
      role: row.role,
      provider: row.provider,
      endpoint: row.endpoint,
      model: row.model,
      apiKeyEncrypted: row.api_key_encrypted,
      credentialRef: row.credential_ref,
      apiKeyFingerprint: row.api_key_fingerprint,
      enabled: row.enabled,
      version: row.version,
      lastTestStatus: row.last_test_status,
      lastTestMessage: row.last_test_message,
      lastTestAt: row.last_test_at?.toISOString?.() ?? row.last_test_at ?? null,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }

  redact(config: ModelConfig): RedactedModelConfig {
    const { apiKeyEncrypted: _secret, credentialRef: _credentialRef, ...safe } = config;
    const refType = credentialRefType(config);
    return {
      ...safe,
      hasCredential: Boolean(config.apiKeyEncrypted || config.credentialRef),
      credential: config.apiKeyEncrypted || config.credentialRef ? "redacted" : null,
      credentialConfigured: Boolean(config.apiKeyEncrypted || config.credentialRef),
      credentialRefType: refType,
      lastFour: config.apiKeyEncrypted ? encryptedLastFour(config.apiKeyEncrypted) : null,
      versionHash: versionHash(config),
    };
  }

  private async resolveCredential(config: ModelConfig): Promise<string> {
    if (config.apiKeyEncrypted) return decryptDbSecret(config.apiKeyEncrypted);
    const ref = config.credentialRef;
    if (!ref) return "";
    if (ref.startsWith("env:")) return process.env[ref.slice(4)] ?? "";
    if (ref.startsWith("file:")) return extractCredentialFromFile(await fs.readFile(ref.slice(5), "utf8"));
    throw new ModelConfigError(`Unsupported credentialRef for ${config.role}. Use env:VAR_NAME${hasEncryptionKey() ? " or file:/path" : ""}.`, 400, "AI_CREDENTIAL_REF_UNSUPPORTED");
  }

  private envFallback(role: ModelRole): ModelConfig | null {
    const prefix = role === "decision_llm" ? "DECISION_LLM" : "VISION_VLM";
    const provider = process.env[`${prefix}_PROVIDER`];
    const model = process.env[`${prefix}_MODEL`];
    const endpoint = process.env[`${prefix}_ENDPOINT`] ?? process.env[`${prefix}_BASE_URL`];
    const credentialRef = process.env[`${prefix}_CREDENTIAL_REF`];
    if (!provider || !model || !credentialRef) return null;
    const now = new Date().toISOString();
    return {
      role,
      provider,
      endpoint: endpoint ?? null,
      model,
      apiKeyEncrypted: null,
      credentialRef,
      apiKeyFingerprint: null,
      enabled: true,
      version: 0,
      lastTestStatus: null,
      lastTestMessage: "env bootstrap fallback",
      lastTestAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async storeTest(role: ModelRole, status: string, message: string): Promise<RedactedModelConfig> {
    const result = await getDb().query(
      `UPDATE model_configs
       SET last_test_status = $2, last_test_message = $3, last_test_at = NOW(), updated_at = NOW()
       WHERE role = $1
       RETURNING *`,
      [role, status, message.slice(0, 1000)]
    );
    this.invalidate(role);
    const config = result.rows[0] ? this.fromRow(result.rows[0]) : (await this.getRaw(role));
    if (!config) throw new ModelConfigError(`Model config for ${role} is missing`, 404, "AI_MODEL_CONFIG_MISSING");
    return this.redact(config);
  }
}

function assertRole(role: string): asserts role is ModelRole {
  if (!ROLES.includes(role as ModelRole)) throw new ModelConfigError(`Unsupported model role: ${role}`, 404, "AI_MODEL_ROLE_UNSUPPORTED");
}

function defaultFor(_role: ModelRole): Pick<ModelConfig, "provider" | "endpoint" | "model"> {
  return { provider: "openai_compatible", endpoint: null, model: "" };
}

function deviceConfigTtlSeconds(): number {
  const raw = Number(process.env.DEVICE_MODEL_CONFIG_TTL_SECONDS ?? process.env.DEVICE_LLM_CONFIG_TTL_SECONDS ?? 900);
  if (!Number.isFinite(raw) || raw <= 0) return 900;
  return Math.max(60, Math.min(Math.floor(raw), 3600));
}

function normalizeNonEmpty(value: string, field: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new ModelConfigError(`${field} is required`);
  return trimmed;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function validateCredentialRef(ref: string | null): string | null {
  if (!ref) return null;
  if (ref.startsWith("env:")) return ref;
  if (ref.startsWith("file:") && hasEncryptionKey()) return ref;
  if (ref.startsWith("file:")) throw new ModelConfigError("file: credential refs require CREDENTIAL_ENCRYPTION_KEY; without it, use env:VAR_NAME refs only.", 400, "AI_CREDENTIAL_ENCRYPTION_REQUIRED");
  throw new ModelConfigError("credentialRef must be env:VAR_NAME or file:/path (file requires CREDENTIAL_ENCRYPTION_KEY)", 400, "AI_CREDENTIAL_REF_UNSUPPORTED");
}

function hasEncryptionKey(): boolean {
  return Boolean(process.env.CREDENTIAL_ENCRYPTION_KEY);
}

function encryptionKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new ModelConfigError("DB secret storage requires CREDENTIAL_ENCRYPTION_KEY. Configure credentialRef=env:VAR_NAME instead.", 400, "AI_CREDENTIAL_ENCRYPTION_REQUIRED");
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptDbSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const lastFour = secret.slice(-4);
  return ["enc", "v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url"), Buffer.from(lastFour).toString("base64url")].join(":");
}

function decryptDbSecret(value: string): string {
  if (!value.startsWith("enc:v1:")) {
    throw new ModelConfigError("Stored DB credential is plaintext/legacy and cannot be used. Re-save it with CREDENTIAL_ENCRYPTION_KEY or switch to env: credentialRef.", 503, "AI_CREDENTIAL_ENCRYPTION_REQUIRED");
  }
  const [, , ivRaw, tagRaw, cipherRaw] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cipherRaw, "base64url")), decipher.final()]).toString("utf8");
}

function encryptedLastFour(value: string): string | null {
  if (!value.startsWith("enc:v1:")) return null;
  const parts = value.split(":");
  return parts[5] ? Buffer.from(parts[5], "base64url").toString("utf8") : null;
}

function credentialRefType(config: ModelConfig): RedactedModelConfig["credentialRefType"] {
  if (config.apiKeyEncrypted) return "db-secret";
  if (config.credentialRef?.startsWith("env:")) return "env";
  if (config.credentialRef?.startsWith("file:")) return "file";
  return null;
}

function versionHash(config: ModelConfig): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    role: config.role,
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    credentialRef: config.credentialRef,
    apiKeyFingerprint: config.apiKeyFingerprint,
    enabled: config.enabled,
    version: config.version,
  })).digest("hex").slice(0, 16);
}

function fingerprint(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

function extractCredentialFromFile(content: string): string {
  const trimmed = content.trim();
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["apiKey", "api_key", "token", "key", "credential"]) {
      if (typeof json[key] === "string" && json[key]) return json[key] as string;
    }
  } catch {
    // Plain text token file.
  }
  return trimmed;
}

function sanitizeProviderError(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|authorization|x-api-key)([\"'\s:=]+)([^\"'\s,}]+)/gi, "$1$2[redacted]")
    .slice(0, 500);
}

function endpointBase(endpoint: string | null, provider: string): string {
  const fallback = provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
  return (endpoint || fallback).replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

async function testProvider(config: ResolvedModelConfig): Promise<void> {
  const provider = config.provider.toLowerCase();
  if (!["anthropic", "openai", "openai_compatible", "minimax"].includes(provider)) {
    throw new ModelConfigError(`Unsupported provider for ${config.role}: ${config.provider}`, 400, "AI_PROVIDER_UNSUPPORTED");
  }
  if (provider === "anthropic") {
    const res = await fetch(`${endpointBase(config.endpoint, provider)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: config.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Provider test failed (${res.status}): ${sanitizeProviderError(await res.text())}`);
    return;
  }

  const path = provider === "minimax" ? "/messages" : "/chat/completions";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "minimax") headers["x-api-key"] = config.apiKey;
  else headers.Authorization = `Bearer ${config.apiKey}`;
  const body = provider === "minimax"
    ? { model: config.model, max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }] }
    : { model: config.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] };
  const res = await fetch(`${endpointBase(config.endpoint, provider)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Provider test failed (${res.status}): ${sanitizeProviderError(await res.text())}`);
}

export const modelConfigService = new ModelConfigService();
