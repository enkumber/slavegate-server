import { api } from "./client";

export type ModelRole = "decision_llm" | "vision_vlm";

export type CredentialMode = "retain" | "replace" | "reference" | "clear";

export interface RedactedModelConfig {
  role: ModelRole;
  provider: string;
  endpoint: string | null;
  model: string;
  enabled: boolean;
  version: number;
  updatedAt: string;
  hasCredential?: boolean;
  credentialConfigured?: boolean;
  credential?: "redacted" | null;
  credentialRefType?: "db-secret" | "env" | "file" | null;
  apiKeyFingerprint?: string | null;
  lastFour?: string | null;
  lastTestStatus?: string | null;
  lastTestMessage?: string | null;
  lastTestAt?: string | null;
  versionHash?: string;
}

export interface ModelConfigDraft {
  provider: string;
  endpoint: string;
  model: string;
  enabled: boolean;
  credentialMode: CredentialMode;
  credential: string;
  credentialRef: string;
}

export interface ModelPatchRequest {
  provider: string;
  endpoint: string | null;
  model: string;
  enabled: boolean;
}

export type CredentialRequest =
  | { credential: string }
  | { credentialRef: string | null };

export const modelRoles: ModelRole[] = ["decision_llm", "vision_vlm"];

const forbiddenResponseKeys = ["apiKey", "api_key", "apiKeyEncrypted", "api_key_encrypted", "credentialRef", "credential_ref"];

export function roleLabel(role: ModelRole): string {
  return role === "decision_llm" ? "Decision LLM" : "Vision VLM";
}

export function emptyDraft(): ModelConfigDraft {
  return {
    provider: "",
    endpoint: "",
    model: "",
    enabled: false,
    credentialMode: "retain",
    credential: "",
    credentialRef: "",
  };
}

export function draftFromConfig(config: RedactedModelConfig | null): ModelConfigDraft {
  if (!config) return emptyDraft();
  return {
    provider: config.provider,
    endpoint: config.endpoint ?? "",
    model: config.model,
    enabled: config.enabled,
    credentialMode: "retain",
    credential: "",
    credentialRef: "",
  };
}

export function buildModelPatch(draft: ModelConfigDraft): ModelPatchRequest {
  return {
    provider: draft.provider.trim(),
    endpoint: draft.endpoint.trim() || null,
    model: draft.model.trim(),
    enabled: draft.enabled,
  };
}

export function buildCredentialRequest(draft: ModelConfigDraft): CredentialRequest | null {
  if (draft.credentialMode === "retain") return null;
  if (draft.credentialMode === "clear") return { credentialRef: null };

  if (draft.credentialMode === "replace") {
    const credential = draft.credential.trim();
    if (!credential) throw new Error("Enter a new API key/token or choose retain.");
    return { credential };
  }

  const credentialRef = draft.credentialRef.trim();
  if (!credentialRef) throw new Error("Enter an env: or file: credential reference, or choose retain.");
  return { credentialRef };
}

export function assertRedactedModelConfig(config: RedactedModelConfig): RedactedModelConfig {
  const payload = config as unknown as Record<string, unknown>;
  for (const key of forbiddenResponseKeys) {
    if (payload[key] !== undefined) throw new Error(`Model config API returned forbidden secret field: ${key}`);
  }
  if (payload.credential !== undefined && payload.credential !== null && payload.credential !== "redacted") {
    throw new Error("Model config API returned an unredacted credential value");
  }
  return config;
}

export function credentialSummary(config: RedactedModelConfig | null): string {
  if (!config) return "Missing config row";
  const configured = config.credentialConfigured ?? config.hasCredential ?? false;
  if (!configured) return "Missing credential";
  if (config.credentialRefType) return `Stored as ${config.credentialRefType}`;
  if (config.apiKeyFingerprint) return `Stored secret ${config.apiKeyFingerprint}`;
  if (config.lastFour) return `Stored secret ending ${config.lastFour}`;
  return "Stored secret";
}

export const modelConfigApi = {
  async list(): Promise<RedactedModelConfig[]> {
    const rows = await api.get<RedactedModelConfig[]>("/server/models");
    return rows.map(assertRedactedModelConfig);
  },

  async update(role: ModelRole, draft: ModelConfigDraft): Promise<RedactedModelConfig> {
    const config = await api.patch<RedactedModelConfig>(`/server/models/${role}`, buildModelPatch(draft));
    return assertRedactedModelConfig(config);
  },

  async updateCredential(role: ModelRole, request: CredentialRequest): Promise<RedactedModelConfig> {
    const config = await api.post<RedactedModelConfig>(`/server/models/${role}/credential`, request);
    return assertRedactedModelConfig(config);
  },

  async test(role: ModelRole): Promise<RedactedModelConfig> {
    const config = await api.post<RedactedModelConfig>(`/server/models/${role}/test`);
    return assertRedactedModelConfig(config);
  },
};
