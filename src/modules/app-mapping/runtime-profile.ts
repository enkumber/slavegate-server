import { getDb } from "../../db/client";

export type SafeMappingAction = string;

export interface RuntimeRecipeTransition {
  sourceStateKey: string;
  targetStateKey: string;
  elementKey: string;
}

export interface RuntimeRecipeStep {
  id: string;
  type: SafeMappingAction | "capture";
  params?: Record<string, unknown>;
  stateKey?: string;
  name?: string;
  optional?: boolean;
  whenInput?: string;
  dependsOn?: string;
  delayAfterMs?: number;
  transition?: RuntimeRecipeTransition;
}

export interface AppMappingEnginePolicy {
  captureStepType: string;
  foregroundProbeActionKey: string;
  treeActionKey: string;
  screenshotActionKey: string;
  foregroundTimeoutMs: number;
  treeTimeoutMs: number;
  screenshotTimeoutMs: number;
  defaultActionTimeoutMs: number;
  captureAttempts: number;
  captureRetryDelayMs: number;
  screenshotQuality: number;
  maxDelayAfterMs: number;
  appVersionFallback: string;
}

export interface AppRuntimeProfile {
  appId: string;
  appName: string;
  packageName: string;
  profileVersion: number;
  resetRecipe: RuntimeRecipeStep[];
  mappingRecipe: RuntimeRecipeStep[];
  safetyPolicy: {
    mode?: string;
    allowedActions: SafeMappingAction[];
    allowedUriHosts?: string[];
    packageScopedActions?: string[];
    uriActions?: Record<string, {
      allowedSchemes?: string[];
      allowedHosts?: string[];
      allowedParams?: Record<string, unknown[]>;
    }>;
    blocked?: string[];
  };
  defaultDeviceId?: string;
  metadata: Record<string, unknown>;
}

export interface RuntimeStateDetectionOverride {
  requiredAnchors?: string[];
  optionalAnchors?: string[];
  forbiddenAnchors?: string[];
}

export interface RuntimeStateDetectionTarget {
  pages: Record<string, {
    detection: {
      anchors: string[];
      optionalAnchors?: string[];
      forbiddenAnchors?: string[];
    };
  }>;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function runtimeStateDetectionOverrides(
  metadata: Record<string, unknown>,
): Record<string, RuntimeStateDetectionOverride> {
  const raw = metadata.stateDetectionOverrides;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("metadata.stateDetectionOverrides must be an object");
  }
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([stateKey, value]) => {
    if (!stateKey.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("each state detection override must be a keyed object");
    }
    const entry = value as Record<string, unknown>;
    return [stateKey, {
      requiredAnchors: stringArray(entry.requiredAnchors, `${stateKey}.requiredAnchors`),
      optionalAnchors: stringArray(entry.optionalAnchors, `${stateKey}.optionalAnchors`),
      forbiddenAnchors: stringArray(entry.forbiddenAnchors, `${stateKey}.forbiddenAnchors`),
    }];
  }));
}

export function applyRuntimeStateDetectionOverrides<T extends RuntimeStateDetectionTarget>(
  map: T,
  metadata: Record<string, unknown>,
): T {
  const overrides = runtimeStateDetectionOverrides(metadata);
  if (Object.keys(overrides).length === 0) return map;

  const pages = Object.fromEntries(Object.entries(map.pages).map(([stateKey, page]) => {
    const override = overrides[stateKey];
    if (!override) return [stateKey, page];
    return [stateKey, {
      ...page,
      detection: {
        ...page.detection,
        anchors: override.requiredAnchors ?? page.detection.anchors,
        optionalAnchors: override.optionalAnchors ?? page.detection.optionalAnchors,
        forbiddenAnchors: override.forbiddenAnchors ?? page.detection.forbiddenAnchors,
      },
    }];
  })) as T["pages"];

  return { ...map, pages };
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error("runtime profile recipe must be a JSON array");
}

function validateStep(raw: unknown, index: number): RuntimeRecipeStep {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`runtime profile step ${index} must be an object`);
  }
  const step = raw as Record<string, unknown>;
  const id = String(step.id ?? "").trim();
  const type = String(step.type ?? "").trim();
  if (!id || !type) throw new Error(`runtime profile step ${index} requires id and type`);
  if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(type)) {
    throw new Error(`runtime profile step ${id} uses an invalid action identifier`);
  }
  return step as unknown as RuntimeRecipeStep;
}

export function appMappingEnginePolicy(profile: AppRuntimeProfile): AppMappingEnginePolicy {
  const raw = profile.metadata?.mappingEnginePolicy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("runtime profile metadata.mappingEnginePolicy is required");
  }
  const source = raw as Record<string, unknown>;
  const requiredString = (key: keyof AppMappingEnginePolicy): string => {
    const value = source[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`mappingEnginePolicy.${key} must be a non-empty string`);
    }
    return value.trim();
  };
  const requiredPositiveInteger = (key: keyof AppMappingEnginePolicy): number => {
    const value = source[key];
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw new Error(`mappingEnginePolicy.${key} must be a positive integer`);
    }
    return Number(value);
  };
  return {
    captureStepType: requiredString("captureStepType"),
    foregroundProbeActionKey: requiredString("foregroundProbeActionKey"),
    treeActionKey: requiredString("treeActionKey"),
    screenshotActionKey: requiredString("screenshotActionKey"),
    foregroundTimeoutMs: requiredPositiveInteger("foregroundTimeoutMs"),
    treeTimeoutMs: requiredPositiveInteger("treeTimeoutMs"),
    screenshotTimeoutMs: requiredPositiveInteger("screenshotTimeoutMs"),
    defaultActionTimeoutMs: requiredPositiveInteger("defaultActionTimeoutMs"),
    captureAttempts: requiredPositiveInteger("captureAttempts"),
    captureRetryDelayMs: requiredPositiveInteger("captureRetryDelayMs"),
    screenshotQuality: requiredPositiveInteger("screenshotQuality"),
    maxDelayAfterMs: requiredPositiveInteger("maxDelayAfterMs"),
    appVersionFallback: requiredString("appVersionFallback"),
  };
}

export function validateRuntimeProfile(profile: AppRuntimeProfile): AppRuntimeProfile {
  if (!profile.appId || !profile.packageName || !profile.appName) {
    throw new Error("runtime profile requires appId, packageName and appName");
  }
  const enginePolicy = appMappingEnginePolicy(profile);
  const allowed = new Set(profile.safetyPolicy.allowedActions ?? []);
  for (const step of [...profile.resetRecipe, ...profile.mappingRecipe]) {
    if (step.type === enginePolicy.captureStepType) {
      if (!String(step.stateKey ?? "").trim() || !String(step.name ?? "").trim()) {
        throw new Error(`capture step ${step.id} requires stateKey and name`);
      }
    } else if (!allowed.has(step.type)) {
      throw new Error(`runtime profile action ${step.type} is not allowed by its safety policy`);
    }
  }
  const ids = new Set<string>();
  for (const step of [...profile.resetRecipe, ...profile.mappingRecipe]) {
    if (ids.has(step.id)) throw new Error(`duplicate runtime profile step id: ${step.id}`);
    ids.add(step.id);
  }
  runtimeStateDetectionOverrides(profile.metadata ?? {});
  return profile;
}

export function runtimeProfileFromRow(row: any): AppRuntimeProfile {
  const resetRecipe = asArray(row.reset_recipe).map(validateStep);
  const mappingRecipe = asArray(row.mapping_recipe).map(validateStep);
  const safetyPolicy = typeof row.safety_policy === "string"
    ? JSON.parse(row.safety_policy)
    : row.safety_policy;
  const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
  return validateRuntimeProfile({
    appId: row.app_id,
    appName: row.app_name,
    packageName: row.package_name,
    profileVersion: Number(row.profile_version),
    resetRecipe,
    mappingRecipe,
    safetyPolicy,
    defaultDeviceId: row.default_device_id ?? undefined,
    metadata: metadata ?? {},
  });
}

export async function loadRuntimeProfile(appId: string): Promise<AppRuntimeProfile | null> {
  const { rows } = await getDb().query(
    `SELECT app_id, app_name, package_name, profile_version, reset_recipe,
            mapping_recipe, safety_policy, default_device_id, metadata
       FROM app_runtime_profiles
      WHERE app_id = $1 AND active = TRUE`,
    [appId],
  );
  return rows[0] ? runtimeProfileFromRow(rows[0]) : null;
}

export async function listRuntimeProfiles(): Promise<Array<Pick<AppRuntimeProfile,
  "appId" | "appName" | "packageName" | "profileVersion" | "defaultDeviceId"
>>> {
  const { rows } = await getDb().query(
    `SELECT app_id, app_name, package_name, profile_version, default_device_id
       FROM app_runtime_profiles
      WHERE active = TRUE
      ORDER BY app_name, app_id`,
  );
  return rows.map((row: any) => ({
    appId: row.app_id,
    appName: row.app_name,
    packageName: row.package_name,
    profileVersion: Number(row.profile_version),
    defaultDeviceId: row.default_device_id ?? undefined,
  }));
}

export async function saveRuntimeProfile(profileInput: AppRuntimeProfile): Promise<AppRuntimeProfile> {
  const profile = validateRuntimeProfile(profileInput);
  await getDb().query(
    `INSERT INTO app_runtime_profiles (
       app_id, app_name, package_name, profile_version, reset_recipe,
       mapping_recipe, safety_policy, default_device_id, metadata, active, updated_at
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::jsonb,TRUE,NOW())
     ON CONFLICT (app_id) DO UPDATE SET
       app_name = EXCLUDED.app_name,
       package_name = EXCLUDED.package_name,
       profile_version = EXCLUDED.profile_version,
       reset_recipe = EXCLUDED.reset_recipe,
       mapping_recipe = EXCLUDED.mapping_recipe,
       safety_policy = EXCLUDED.safety_policy,
       default_device_id = EXCLUDED.default_device_id,
       metadata = EXCLUDED.metadata,
       active = TRUE,
       updated_at = NOW()`,
    [
      profile.appId,
      profile.appName,
      profile.packageName,
      profile.profileVersion,
      JSON.stringify(profile.resetRecipe),
      JSON.stringify(profile.mappingRecipe),
      JSON.stringify(profile.safetyPolicy),
      profile.defaultDeviceId ?? null,
      JSON.stringify(profile.metadata ?? {}),
    ],
  );
  return profile;
}

export function renderRuntimeParams(
  value: unknown,
  profile: AppRuntimeProfile,
  input: Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => renderRuntimeParams(entry, profile, input));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, renderRuntimeParams(entry, profile, input)]),
    );
  }
  if (typeof value !== "string") return value;
  if (value === "{{packageName}}") return profile.packageName;
  const inputMatch = /^\{\{input\.([a-zA-Z0-9_]+)\}\}$/.exec(value);
  if (inputMatch) return input[inputMatch[1]];
  if (value.includes("{{")) throw new Error(`unsupported runtime profile template: ${value}`);
  return value;
}

export function assertRuntimeActionSafe(
  profile: AppRuntimeProfile,
  step: RuntimeRecipeStep,
  params: Record<string, unknown>,
): void {
  if (step.type === appMappingEnginePolicy(profile).captureStepType) return;
  if (!profile.safetyPolicy.allowedActions.includes(step.type)) {
    throw new Error(`action ${step.type} is not allowed for ${profile.appId}`);
  }
  if ((profile.safetyPolicy.packageScopedActions ?? []).includes(step.type)
    && params.packageName !== profile.packageName) {
    throw new Error(`${step.type} packageName must match the runtime profile`);
  }
  const uriPolicy = profile.safetyPolicy.uriActions?.[step.type];
  if (uriPolicy) {
    if (params.packageName !== profile.packageName) {
      throw new Error(`${step.type} packageName must match the runtime profile`);
    }
    const uri = String(params.uri ?? "");
    const parsed = new URL(uri);
    const schemes = uriPolicy.allowedSchemes ?? [];
    const hosts = uriPolicy.allowedHosts ?? profile.safetyPolicy.allowedUriHosts ?? [];
    if (!schemes.includes(parsed.protocol)
      || !hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
      throw new Error(`URI host is not allowed by runtime profile: ${parsed.hostname}`);
    }
    for (const [key, allowedValues] of Object.entries(uriPolicy.allowedParams ?? {})) {
      if (!Array.isArray(allowedValues) || !allowedValues.some((allowed) => Object.is(allowed, params[key]))) {
        throw new Error(`${step.type} parameter '${key}' is not allowed by runtime profile`);
      }
    }
  }
}
