/**
 * Server-side model/token configuration for Phone Network.
 * DB rows are primary. Env is only an explicit credential ref or bootstrap fallback
 * when DB rows are absent. API responses are always redacted.
 */

import crypto from "crypto";
import dns from "dns/promises";
import fs from "fs/promises";
import http from "http";
import https from "https";
import net from "net";
import path from "path";
import type { Pool, PoolClient } from "pg";
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
  hasCredential: boolean;
  credentialDelivery: "server_only";
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
}

interface CredentialInput {
  credential?: string;
  apiKey?: string;
  credentialRef?: string | null;
}

interface ParsedLegacyVisionConfigInput {
  metadata: UpdateModelConfigInput;
  credentialRef: string | null | undefined;
}

interface ResolvedModelConfig extends ModelConfig {
  apiKey: string;
}

const ROLES: ModelRole[] = ["decision_llm", "vision_vlm"];
const CACHE_TTL_MS = 30_000;
const MODEL_CONFIG_LOCK_NAMESPACE = "phone-network:model-config";
const MODEL_CONFIG_CREDENTIAL_FIELD_NAMES = new Set([
  "authorization",
  "authorizationheader",
  "credential",
  "credentials",
  "credentialconfigured",
  "credentialref",
  "credentialreference",
  "credentialvalue",
  "clearcredential",
  "deletecredential",
  "removecredential",
  "apikey",
  "apikeyconfigured",
  "apikeyencrypted",
  "apikeyfingerprint",
  "apikeyref",
  "apikeyreference",
  "clearapikey",
  "deleteapikey",
  "removeapikey",
  "xapikey",
  "token",
  "accesstoken",
  "authtoken",
  "providertoken",
  "cleartoken",
  "deletetoken",
  "removetoken",
  "secret",
  "clientsecret",
]);
const LEGACY_VISION_METADATA_FIELDS = new Set(["provider", "endpoint", "model", "enabled"]);
const LEGACY_VISION_CREDENTIAL_REF_FIELDS = new Set(["credentialRef", "apiKeyRef", "api_key_ref"]);
type EndpointAddress = { address: string; family?: number };
type EndpointAddressResolver = (hostname: string) => Promise<EndpointAddress[]>;

const defaultEndpointAddressResolver: EndpointAddressResolver = async (hostname) => {
  if (net.isIP(hostname)) return [{ address: hostname }];
  return dns.lookup(hostname, { all: true, verbatim: true });
};

let endpointAddressResolver: EndpointAddressResolver = defaultEndpointAddressResolver;

export function setModelConfigEndpointResolverForTests(resolver?: EndpointAddressResolver): void {
  endpointAddressResolver = resolver ?? defaultEndpointAddressResolver;
}

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

  constructor(private readonly dbProvider: () => Pick<Pool, "query" | "connect"> = getDb) {}

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
    assertModelConfigMetadataOnlyInput(input);
    const saved = await this.withRoleMutationTransaction(role, async (client) => {
      const locked = await client.query(
        "SELECT * FROM model_configs WHERE role = $1 FOR UPDATE",
        [role],
      );
      const existing = locked.rows[0] ? this.fromRow(locked.rows[0]) : null;
      const provider = validateProvider(input.provider ?? existing?.provider ?? defaultFor(role).provider, role);
      const model = normalizeNonEmpty(input.model ?? existing?.model ?? defaultFor(role).model, "model");
      const enabled = input.enabled !== undefined ? Boolean(input.enabled) : existing?.enabled ?? false;
      const endpoint = validateEndpointForStorage(
        input.endpoint !== undefined
          ? nullableString(input.endpoint)
          : existing?.endpoint ?? defaultFor(role).endpoint,
        provider,
        role,
        enabled,
      );

      // Never copy credential columns from a metadata snapshot. Even if another
      // writer is introduced without the service lock, this UPSERT cannot roll
      // a credential replacement back to an older value.
      const result = await client.query(
        `INSERT INTO model_configs
           (role, provider, endpoint, model, enabled, version)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (role) DO UPDATE SET
           provider = EXCLUDED.provider,
           endpoint = EXCLUDED.endpoint,
           model = EXCLUDED.model,
           enabled = EXCLUDED.enabled,
           version = model_configs.version + 1,
           updated_at = NOW()
         RETURNING *`,
        [role, provider, endpoint, model, enabled],
      );
      return this.fromRow(result.rows[0]);
    });
    this.invalidate(role);
    return this.redact(saved);
  }

  async updateCredential(role: ModelRole, input: CredentialInput): Promise<RedactedModelConfig> {
    assertRole(role);
    const rawCredential = input.credential ?? input.apiKey;
    const credentialRef = input.credentialRef !== undefined ? validateCredentialRef(nullableString(input.credentialRef)) : undefined;
    let apiKeyEncrypted: string | null;
    let apiKeyFingerprint: string | null;
    let nextCredentialRef: string | null;

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

    const saved = await this.withRoleMutationTransaction(role, async (client) => {
      const locked = await client.query(
        "SELECT * FROM model_configs WHERE role = $1 FOR UPDATE",
        [role],
      );
      if (!locked.rows[0]) {
        throw new ModelConfigError(`Model config for ${role} is missing`, 404, "AI_MODEL_CONFIG_MISSING");
      }
      const result = await client.query(
        `UPDATE model_configs
         SET api_key_encrypted = $2,
             credential_ref = $3,
             api_key_fingerprint = $4,
             version = version + 1,
             updated_at = NOW()
         WHERE role = $1
         RETURNING *`,
        [role, apiKeyEncrypted, nextCredentialRef, apiKeyFingerprint],
      );
      return this.fromRow(result.rows[0]);
    });
    this.invalidate(role);
    return this.redact(saved);
  }

  /**
   * Backward-compatible /vision/config mutation. The complete legacy request is
   * validated before a connection is acquired, then metadata and the optional
   * credential-ref replacement/clear are persisted in one transaction and one
   * row statement. This prevents a credential failure from leaving newer
   * metadata committed beside the old active secret.
   */
  async updateLegacyVisionConfig(input: unknown): Promise<RedactedModelConfig> {
    const parsed = parseLegacyVisionConfigInput(input);
    const saved = await this.withRoleMutationTransaction("vision_vlm", async (client) => {
      const locked = await client.query(
        "SELECT * FROM model_configs WHERE role = $1 FOR UPDATE",
        ["vision_vlm"],
      );
      const existing = locked.rows[0] ? this.fromRow(locked.rows[0]) : null;
      const provider = validateProvider(
        parsed.metadata.provider ?? existing?.provider ?? defaultFor("vision_vlm").provider,
        "vision_vlm",
      );
      const model = normalizeNonEmpty(
        parsed.metadata.model ?? existing?.model ?? defaultFor("vision_vlm").model,
        "model",
      );
      const enabled = parsed.metadata.enabled !== undefined
        ? parsed.metadata.enabled
        : existing?.enabled ?? false;
      const endpoint = validateEndpointForStorage(
        parsed.metadata.endpoint !== undefined
          ? parsed.metadata.endpoint
          : existing?.endpoint ?? defaultFor("vision_vlm").endpoint,
        provider,
        "vision_vlm",
        enabled,
      );
      const credentialChanged = parsed.credentialRef !== undefined;
      const result = credentialChanged
        ? await client.query(
          `INSERT INTO model_configs
             (role, provider, endpoint, model, api_key_encrypted, credential_ref, api_key_fingerprint, enabled, version)
           VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, 1)
           ON CONFLICT (role) DO UPDATE SET
             provider = EXCLUDED.provider,
             endpoint = EXCLUDED.endpoint,
             model = EXCLUDED.model,
             api_key_encrypted = NULL,
             credential_ref = EXCLUDED.credential_ref,
             api_key_fingerprint = NULL,
             enabled = EXCLUDED.enabled,
             version = model_configs.version + 1,
             updated_at = NOW()
           RETURNING *`,
          ["vision_vlm", provider, endpoint, model, parsed.credentialRef, enabled],
        )
        : await client.query(
          `INSERT INTO model_configs
             (role, provider, endpoint, model, enabled, version)
           VALUES ($1, $2, $3, $4, $5, 1)
           ON CONFLICT (role) DO UPDATE SET
             provider = EXCLUDED.provider,
             endpoint = EXCLUDED.endpoint,
             model = EXCLUDED.model,
             enabled = EXCLUDED.enabled,
             version = model_configs.version + 1,
             updated_at = NOW()
           RETURNING *`,
          ["vision_vlm", provider, endpoint, model, enabled],
        );
      return this.fromRow(result.rows[0]);
    });
    this.invalidate("vision_vlm");
    return this.redact(saved);
  }

  async resolve(role: ModelRole): Promise<ResolvedModelConfig> {
    const rawConfig = await this.getRaw(role) ?? this.envFallback(role);
    if (!rawConfig) throw new ModelConfigError(`Model config for ${role} is missing. Configure it in Dashboard → Tokens / Models.`, 503, "AI_MODEL_CONFIG_MISSING");
    if (!rawConfig.enabled) throw new ModelConfigError(`Model config for ${role} is disabled. Enable it in Dashboard → Tokens / Models.`, 503, "AI_MODEL_DISABLED");
    const provider = validateProvider(rawConfig.provider, role);
    const config = {
      ...rawConfig,
      provider,
      endpoint: validateEndpoint(rawConfig.endpoint, provider, role),
    };
    await validateEndpointNetwork(config.endpoint, provider, role);
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
        hasCredential: true,
        credentialDelivery: "server_only",
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
      const message = sanitizeProviderError((err as Error).message);
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
      const result = await this.dbProvider().query(sql, params);
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
      lastTestMessage: config.lastTestMessage === null ? null : sanitizeProviderError(config.lastTestMessage),
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
    const validatedRef = validateCredentialRef(ref);
    if (!validatedRef) return "";
    if (validatedRef.startsWith("env:")) return process.env[validatedRef.slice(4)] ?? "";
    if (validatedRef.startsWith("file:")) return extractCredentialFromFile(await fs.readFile(await resolveCredentialFilePathForRead(validatedRef), "utf8"));
    throw new ModelConfigError(`Unsupported credentialRef for ${config.role}. Use env:VAR_NAME${hasEncryptionKey() ? " or file:/path" : ""}.`, 400, "AI_CREDENTIAL_REF_UNSUPPORTED");
  }

  private envFallback(role: ModelRole): ModelConfig | null {
    const prefix = role === "decision_llm" ? "DECISION_LLM" : "VISION_VLM";
    const provider = process.env[`${prefix}_PROVIDER`];
    const model = process.env[`${prefix}_MODEL`];
    const endpoint = process.env[`${prefix}_ENDPOINT`] ?? process.env[`${prefix}_BASE_URL`];
    const credentialRef = process.env[`${prefix}_CREDENTIAL_REF`];
    if (!provider || !model || !credentialRef) return null;
    const normalizedProvider = validateProvider(provider, role);
    const normalizedEndpoint = validateEndpoint(endpoint ?? null, normalizedProvider, role);
    const normalizedCredentialRef = validateCredentialRef(credentialRef);
    const now = new Date().toISOString();
    return {
      role,
      provider: normalizedProvider,
      endpoint: normalizedEndpoint,
      model,
      apiKeyEncrypted: null,
      credentialRef: normalizedCredentialRef,
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
    const sanitizedMessage = sanitizeProviderError(message);
    const saved = await this.withRoleMutationTransaction(role, async (client) => {
      const result = await client.query(
        `UPDATE model_configs
         SET last_test_status = $2, last_test_message = $3, last_test_at = NOW(), updated_at = NOW()
         WHERE role = $1
         RETURNING *`,
        [role, status, sanitizedMessage],
      );
      if (!result.rows[0]) {
        throw new ModelConfigError(`Model config for ${role} is missing`, 404, "AI_MODEL_CONFIG_MISSING");
      }
      return this.fromRow(result.rows[0]);
    });
    this.invalidate(role);
    return this.redact(saved);
  }

  /** Serialize role mutations even before the role row exists. */
  private async withRoleMutationTransaction<T>(
    role: ModelRole,
    mutation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.dbProvider().connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${MODEL_CONFIG_LOCK_NAMESPACE}:${role}`],
      );
      const result = await mutation(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (err: any) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      if (err?.code === "42P01") {
        throw new ModelConfigError(
          "model_configs table is missing. Run database migrations.",
          503,
          "AI_MODEL_CONFIG_MISSING",
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export function assertModelConfigMetadataOnlyInput(input: unknown): asserts input is UpdateModelConfigInput {
  if (!input || typeof input !== "object") return;
  const credentialField = Object.keys(input).find((field) => {
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, "");
    return MODEL_CONFIG_CREDENTIAL_FIELD_NAMES.has(normalized) ||
      normalized.includes("credential") ||
      normalized.includes("authorization") ||
      normalized.includes("apikey") ||
      normalized.includes("token") ||
      normalized.includes("secret");
  });
  if (!credentialField) return;
  throw new ModelConfigError(
    "Credential fields are not accepted on model metadata routes. Use the matching /credential endpoint to update or clear credentials.",
    400,
    "AI_MODEL_CONFIG_CREDENTIAL_FIELD_REJECTED",
  );
}

function parseLegacyVisionConfigInput(input: unknown): ParsedLegacyVisionConfigInput {
  if (input === undefined || input === null) return { metadata: {}, credentialRef: undefined };
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ModelConfigError(
      "Legacy vision config payload must be a JSON object.",
      400,
      "AI_LEGACY_VISION_PAYLOAD_INVALID",
    );
  }

  const body = input as Record<string, unknown>;
  const fields = Object.keys(body);
  const supportedCredentialFields = fields.filter((field) => LEGACY_VISION_CREDENTIAL_REF_FIELDS.has(field));
  const unsupportedFields = fields.filter((field) =>
    !LEGACY_VISION_METADATA_FIELDS.has(field) && !LEGACY_VISION_CREDENTIAL_REF_FIELDS.has(field),
  );
  const unsupportedCredentialField = unsupportedFields.find(isCredentialLikeField);
  if (unsupportedCredentialField) {
    throw new ModelConfigError(
      "Unsupported credential field on the legacy vision config route. Use credentialRef, apiKeyRef, or api_key_ref for an atomic reference replacement/clear, or use /api/model-configs/vision_vlm/credential.",
      400,
      "AI_LEGACY_VISION_CREDENTIAL_FIELD_REJECTED",
    );
  }
  if (unsupportedFields.length) {
    throw new ModelConfigError(
      `Unsupported legacy vision config field: ${unsupportedFields[0]}`,
      400,
      "AI_LEGACY_VISION_FIELD_UNSUPPORTED",
    );
  }
  if (supportedCredentialFields.length > 1) {
    throw new ModelConfigError(
      "Specify only one of credentialRef, apiKeyRef, or api_key_ref.",
      400,
      "AI_LEGACY_VISION_CREDENTIAL_FIELD_AMBIGUOUS",
    );
  }

  const metadata: UpdateModelConfigInput = {};
  if (Object.prototype.hasOwnProperty.call(body, "provider")) {
    if (typeof body.provider !== "string") throw legacyVisionFieldTypeError("provider", "a string");
    metadata.provider = body.provider;
  }
  if (Object.prototype.hasOwnProperty.call(body, "model")) {
    if (typeof body.model !== "string") throw legacyVisionFieldTypeError("model", "a string");
    metadata.model = body.model;
  }
  if (Object.prototype.hasOwnProperty.call(body, "endpoint")) {
    if (body.endpoint !== null && typeof body.endpoint !== "string") {
      throw legacyVisionFieldTypeError("endpoint", "a string or null");
    }
    metadata.endpoint = body.endpoint as string | null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
    if (typeof body.enabled !== "boolean") throw legacyVisionFieldTypeError("enabled", "a boolean");
    metadata.enabled = body.enabled;
  }

  if (!supportedCredentialFields.length) return { metadata, credentialRef: undefined };
  const credentialField = supportedCredentialFields[0];
  const rawRef = body[credentialField];
  if (rawRef !== null && typeof rawRef !== "string") {
    throw legacyVisionFieldTypeError(credentialField, "a credential reference string or explicit null to clear");
  }
  if (typeof rawRef === "string" && !rawRef.trim()) {
    throw new ModelConfigError(
      `${credentialField} must be a non-empty env: or allowlisted file: reference; use explicit null to clear.`,
      400,
      "AI_CREDENTIAL_REF_UNSUPPORTED",
    );
  }
  return {
    metadata,
    credentialRef: validateCredentialRef(rawRef === null ? null : rawRef.trim()),
  };
}

function isCredentialLikeField(field: string): boolean {
  const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, "");
  return MODEL_CONFIG_CREDENTIAL_FIELD_NAMES.has(normalized) ||
    normalized.includes("credential") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret");
}

function legacyVisionFieldTypeError(field: string, expected: string): ModelConfigError {
  return new ModelConfigError(
    `Legacy vision config field ${field} must be ${expected}.`,
    400,
    "AI_LEGACY_VISION_FIELD_INVALID",
  );
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

function validateProvider(provider: string, role: ModelRole): string {
  const normalized = normalizeNonEmpty(provider, "provider").toLowerCase().replace("-", "_");
  if (normalized === "openai" || normalized === "openai_compatible") return normalized;
  throw new ModelConfigError(`Unsupported provider for ${role}: ${provider}. Supported: openai, openai_compatible.`, 400, "AI_PROVIDER_UNSUPPORTED");
}

function validateEndpoint(endpoint: string | null, provider: string, role: ModelRole): string | null {
  if (!endpoint) {
    if (provider === "openai") return null;
    throw new ModelConfigError(`Endpoint is required for ${role} when provider is openai_compatible.`, 400, "AI_ENDPOINT_REQUIRED");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ModelConfigError(`Invalid endpoint URL for ${role}. Use an http(s) OpenAI-compatible base URL.`, 400, "AI_ENDPOINT_INVALID");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ModelConfigError(`Invalid endpoint protocol for ${role}. Only http and https are supported.`, 400, "AI_ENDPOINT_PROTOCOL_UNSUPPORTED");
  }
  const endpointPolicy = endpointPolicyForHost(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new ModelConfigError(`Invalid endpoint URL for ${role}. Credentials and fragments are not allowed in endpoint URLs.`, 400, "AI_ENDPOINT_INVALID");
  }
  if (parsed.protocol === "http:" && !endpointPolicy.allowPrivate) {
    throw new ModelConfigError(`Model endpoint for ${role} must use HTTPS. Plain HTTP is allowed only for hosts explicitly declared local:<host> in MODEL_CONFIG_ENDPOINT_ALLOWLIST.`, 400, "AI_ENDPOINT_HTTPS_REQUIRED");
  }
  if (!endpointPolicy.allowlisted) {
    throw new ModelConfigError(`Model endpoint for ${role} must be explicitly allowlisted with MODEL_CONFIG_ENDPOINT_ALLOWLIST.`, 400, "AI_ENDPOINT_NOT_ALLOWLISTED");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function validateEndpointForStorage(endpoint: string | null, provider: string, role: ModelRole, enabled: boolean): string | null {
  if (endpoint) return validateEndpoint(endpoint, provider, role);
  if (enabled) return validateEndpoint(endpoint, provider, role);
  return null;
}

async function validateEndpointNetwork(endpoint: string | null, provider: string, role: ModelRole): Promise<void> {
  const base = endpointBase(endpoint, provider);
  const parsed = new URL(base);
  const policy = endpointPolicyForHost(parsed.hostname);
  if (!policy.allowlisted) {
    throw new ModelConfigError(`Model endpoint for ${role} must be explicitly allowlisted with MODEL_CONFIG_ENDPOINT_ALLOWLIST.`, 400, "AI_ENDPOINT_NOT_ALLOWLISTED");
  }

  let addresses: EndpointAddress[];
  try {
    addresses = await endpointAddressResolver(parsed.hostname);
  } catch {
    throw new ModelConfigError(`Model endpoint DNS lookup failed for ${role}.`, 503, "AI_ENDPOINT_DNS_FAILED");
  }

  if (!addresses.length) {
    throw new ModelConfigError(`Model endpoint DNS lookup returned no addresses for ${role}.`, 503, "AI_ENDPOINT_DNS_FAILED");
  }

  for (const entry of addresses) {
    if (isBlockedEndpointAddress(entry.address) && !policy.allowPrivate) {
      throw new ModelConfigError(`Model endpoint for ${role} resolved to a private, local, metadata, or reserved address. Use local:<host> in MODEL_CONFIG_ENDPOINT_ALLOWLIST only for an intended local provider.`, 400, "AI_ENDPOINT_PRIVATE_ADDRESS");
    }
  }
}

async function resolveAllowedEndpointAddress(hostname: string, role: ModelRole): Promise<EndpointAddress> {
  const policy = endpointPolicyForHost(hostname);
  if (!policy.allowlisted) {
    throw new ModelConfigError(`Model endpoint for ${role} must be explicitly allowlisted with MODEL_CONFIG_ENDPOINT_ALLOWLIST.`, 400, "AI_ENDPOINT_NOT_ALLOWLISTED");
  }
  let addresses: EndpointAddress[];
  try {
    addresses = await endpointAddressResolver(hostname);
  } catch {
    throw new ModelConfigError(`Model endpoint DNS lookup failed for ${role}.`, 503, "AI_ENDPOINT_DNS_FAILED");
  }
  if (!addresses.length) {
    throw new ModelConfigError(`Model endpoint DNS lookup returned no addresses for ${role}.`, 503, "AI_ENDPOINT_DNS_FAILED");
  }
  for (const entry of addresses) {
    if (isBlockedEndpointAddress(entry.address) && !policy.allowPrivate) {
      throw new ModelConfigError(`Model endpoint for ${role} resolved to a private, local, metadata, or reserved address. Use local:<host> in MODEL_CONFIG_ENDPOINT_ALLOWLIST only for an intended local provider.`, 400, "AI_ENDPOINT_PRIVATE_ADDRESS");
    }
  }
  return addresses[0];
}

/** Credential-safe provider transport. DNS policy is enforced by the lookup used
 * by the actual socket, preventing a validated hostname from being resolved a
 * second time by an unrelated transport. HTTPS still receives the original
 * hostname for SNI and certificate verification. */
export async function modelConfigFetch(url: string, init: RequestInit = {}, role: ModelRole): Promise<Response> {
  const parsed = new URL(url);
  const policy = endpointPolicyForHost(parsed.hostname);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelConfigError(`Invalid endpoint protocol for ${role}. Only http and https are supported.`, 400, "AI_ENDPOINT_PROTOCOL_UNSUPPORTED");
  }
  if (!policy.allowlisted) {
    throw new ModelConfigError(`Model endpoint for ${role} must be explicitly allowlisted with MODEL_CONFIG_ENDPOINT_ALLOWLIST.`, 400, "AI_ENDPOINT_NOT_ALLOWLISTED");
  }
  if (parsed.protocol === "http:" && !policy.allowPrivate) {
    throw new ModelConfigError(`Model endpoint for ${role} must use HTTPS. Plain HTTP is allowed only for hosts explicitly declared local:<host> in MODEL_CONFIG_ENDPOINT_ALLOWLIST.`, 400, "AI_ENDPOINT_HTTPS_REQUIRED");
  }
  if (net.isIP(parsed.hostname) && isBlockedEndpointAddress(parsed.hostname) && !policy.allowPrivate) {
    throw new ModelConfigError(`Model endpoint for ${role} resolved to a private, local, metadata, or reserved address. Use local:<host> in MODEL_CONFIG_ENDPOINT_ALLOWLIST only for an intended local provider.`, 400, "AI_ENDPOINT_PRIVATE_ADDRESS");
  }

  const headers = new Headers(init.headers);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => { requestHeaders[name] = value; });
  const body = init.body == null ? undefined : String(init.body);
  return new Promise<Response>((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(parsed, {
      method: init.method ?? "GET",
      headers: requestHeaders,
      lookup: (hostname: string, optionsOrCallback: { all?: boolean } | ((...args: any[]) => void), maybeCallback?: (...args: any[]) => void) => {
        const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
        const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
        if (!callback) return;
        resolveAllowedEndpointAddress(hostname, role).then(
          (entry) => {
            const family = entry.family ?? net.isIP(entry.address);
            if (options.all) callback(null, [{ address: entry.address, family }]);
            else callback(null, entry.address, family);
          },
          (error) => callback(error as NodeJS.ErrnoException, "", 0),
        );
      },
      ...(parsed.protocol === "https:" ? { servername: parsed.hostname } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 502,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    request.on("error", reject);
    const onAbort = () => request.destroy(new DOMException("The operation was aborted", "AbortError"));
    if (init.signal?.aborted) onAbort();
    else init.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("close", () => init.signal?.removeEventListener("abort", onAbort));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function endpointPolicyForHost(hostname: string): { allowlisted: boolean; allowPrivate: boolean } {
  const host = hostname.toLowerCase();
  if (host === "api.openai.com" || host.endsWith(".openai.com")) {
    return { allowlisted: true, allowPrivate: false };
  }
  const allowlist = (process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const allowPrivate = allowlist.some((entry) => entry === `local:${host}`);
  const allowlisted = allowPrivate || allowlist.some((entry) => entry === host);
  return { allowlisted, allowPrivate };
}

function isBlockedEndpointAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) {
    return isBlockedEndpointAddress(address.slice(7));
  }

  if (net.isIPv4(address)) {
    const octets = address.split(".").map((part) => Number(part));
    const [a, b] = octets;
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0) ||
      a >= 224;
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb");
  }

  return true;
}

function validateCredentialRef(ref: string | null): string | null {
  if (!ref) return null;
  if (ref.startsWith("env:")) {
    const name = ref.slice(4);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ModelConfigError("credentialRef env name is invalid. Use env:VAR_NAME.", 400, "AI_CREDENTIAL_REF_UNSUPPORTED");
    }
    return ref;
  }
  if (ref.startsWith("file:") && hasEncryptionKey()) {
    resolveCredentialFilePath(ref);
    return ref;
  }
  if (ref.startsWith("file:")) throw new ModelConfigError("file: credential refs require CREDENTIAL_ENCRYPTION_KEY; without it, use env:VAR_NAME refs only.", 400, "AI_CREDENTIAL_ENCRYPTION_REQUIRED");
  throw new ModelConfigError("credentialRef must be env:VAR_NAME or file:/path (file requires CREDENTIAL_ENCRYPTION_KEY)", 400, "AI_CREDENTIAL_REF_UNSUPPORTED");
}

function resolveCredentialFilePath(ref: string): string {
  const rawPath = ref.slice(5);
  if (!rawPath) throw new ModelConfigError("file: credentialRef path is required.", 400, "AI_CREDENTIAL_REF_UNSUPPORTED");
  const resolved = path.resolve(rawPath);
  const allowedDirs = (process.env.MODEL_CONFIG_CREDENTIAL_FILE_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  if (!allowedDirs.length) {
    throw new ModelConfigError("file: credential refs require MODEL_CONFIG_CREDENTIAL_FILE_ALLOWLIST. Use env:VAR_NAME refs unless a server credential directory is explicitly allowlisted.", 400, "AI_CREDENTIAL_REF_NOT_ALLOWLISTED");
  }
  const allowed = allowedDirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`));
  if (!allowed) {
    throw new ModelConfigError("file: credentialRef path is outside the server credential allowlist.", 400, "AI_CREDENTIAL_REF_NOT_ALLOWLISTED");
  }
  return resolved;
}

async function resolveCredentialFilePathForRead(ref: string): Promise<string> {
  const resolved = resolveCredentialFilePath(ref);
  const realPath = await fs.realpath(resolved);
  const allowedDirs = await Promise.all((process.env.MODEL_CONFIG_CREDENTIAL_FILE_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => fs.realpath(path.resolve(entry))));
  const allowed = allowedDirs.some((dir) => realPath === dir || realPath.startsWith(`${dir}${path.sep}`));
  if (!allowed) {
    throw new ModelConfigError("file: credentialRef path escapes the server credential allowlist.", 400, "AI_CREDENTIAL_REF_NOT_ALLOWLISTED");
  }
  return realPath;
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

export function sanitizeProviderError(text: string): string {
  const trimmed = String(text ?? "");
  const jsonRedacted = redactProviderErrorJson(trimmed);
  return redactProviderErrorText(jsonRedacted ?? trimmed).slice(0, 500);
}

function redactProviderErrorJson(text: string): string | null {
  try {
    return JSON.stringify(redactProviderErrorValue(JSON.parse(text)));
  } catch {
    return null;
  }
}

function redactProviderErrorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactProviderErrorValue(entry));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      redacted[key] = isSensitiveProviderErrorKey(key) ? "[redacted]" : redactProviderErrorValue(nested);
    }
    return redacted;
  }
  if (typeof value === "string") return redactProviderErrorText(value);
  return value;
}

function isSensitiveProviderErrorKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /(?:proxy)?authorization(?:header)?(?:value)?$/.test(normalized) ||
    /apikey(?:header|value|provided|supplied|ref|reference|encrypted|fingerprint)?$/.test(normalized) ||
    /credential(?:s|header|value|ref|reference)?$/.test(normalized) ||
    /token(?:header|value|ref|reference)?$/.test(normalized) ||
    /secret(?:header|value|ref|reference)?$/.test(normalized) ||
    normalized === "cookie" ||
    normalized === "setcookie";
}

function redactProviderErrorText(text: string): string {
  return text
    .replace(/((?:proxy[-_\s]*)?authorization(?:[-_\s]*header)?(?:[-_\s]*value)?\s*(?:=>|:|=)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic)\s+[^\s,;}\]\r\n]+|[^\s,;}\]\r\n]+)/gi, "$1[redacted]")
    .replace(/(\b(?:(?:invalid|incorrect|expired|revoked|malformed)\s+)?(?:x[-_\s]*)?api[-_\s]*key(?:[-_\s]+(?:value|provided|supplied|received|submitted|used))?(?:[-_\s]+(?:is|was))?\s*(?:=>|:|=)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/gi, "$1[redacted]")
    .replace(/(\b(?:(?:invalid|incorrect|expired|revoked|malformed)\s+)?(?:(?:x[-_\s]*)?(?:auth(?:entication)?[-_\s]*)?|access[-_\s]*|provider[-_\s]*|refresh[-_\s]*|bearer[-_\s]*|basic[-_\s]*)?(?:token|credential|secret)(?:[-_\s]+(?:value|provided|supplied|received|submitted|used))?(?:[-_\s]+(?:is|was))?\s*(?:=>|:|=)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
    .replace(/\bsk-[A-Za-z0-9._~+\/-]+=?/g, "[redacted]")
    .replace(/([\"'](?:proxy[-_\s]*)?authorization(?:[-_\s]*header)?(?:[-_\s]*value)?[\"']\s*:\s*[\"'])([^\"']*)([\"'])/gi, "$1[redacted]$3");
}

function endpointBase(endpoint: string | null, provider: string): string {
  const normalizedProvider = provider.toLowerCase().replace("-", "_");
  if (!endpoint && normalizedProvider === "openai") return "https://api.openai.com/v1";
  if (!endpoint) throw new ModelConfigError("OpenAI-compatible endpoint is missing.", 503, "AI_ENDPOINT_REQUIRED");
  return endpoint.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

async function testProvider(config: ResolvedModelConfig): Promise<void> {
  const provider = config.provider.toLowerCase();
  if (!["openai", "openai_compatible"].includes(provider)) {
    throw new ModelConfigError(`Unsupported provider for ${config.role}: ${config.provider}`, 400, "AI_PROVIDER_UNSUPPORTED");
  }
  const path = "/chat/completions";
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers.Authorization = `Bearer ${config.apiKey}`;
  const body = { model: config.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] };
  const res = await modelConfigFetch(`${endpointBase(config.endpoint, provider)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }, config.role);
  if (!res.ok) throw new Error(`Provider test failed (${res.status}): ${sanitizeProviderError(await res.text())}`);
}

export const modelConfigService = new ModelConfigService();
