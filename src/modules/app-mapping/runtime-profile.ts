import { getDb } from "../../db/client";

export const SAFE_MAPPING_ACTIONS = [
  "open_app",
  "intent_send",
  "wait_for_idle",
  "a11y_find_tap",
  "scroll",
  "press_key",
] as const;

export type SafeMappingAction = typeof SAFE_MAPPING_ACTIONS[number];

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

export interface AppRuntimeProfile {
  appId: string;
  appName: string;
  packageName: string;
  profileVersion: number;
  resetRecipe: RuntimeRecipeStep[];
  mappingRecipe: RuntimeRecipeStep[];
  safetyPolicy: {
    mode: "read_only_navigation";
    allowedActions: SafeMappingAction[];
    allowedUriHosts?: string[];
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
  if (type !== "capture" && !(SAFE_MAPPING_ACTIONS as readonly string[]).includes(type)) {
    throw new Error(`runtime profile step ${id} uses unsafe/unsupported action: ${type}`);
  }
  if (type === "capture" && (!String(step.stateKey ?? "").trim() || !String(step.name ?? "").trim())) {
    throw new Error(`capture step ${id} requires stateKey and name`);
  }
  return step as unknown as RuntimeRecipeStep;
}

export function validateRuntimeProfile(profile: AppRuntimeProfile): AppRuntimeProfile {
  if (!profile.appId || !profile.packageName || !profile.appName) {
    throw new Error("runtime profile requires appId, packageName and appName");
  }
  if (profile.safetyPolicy?.mode !== "read_only_navigation") {
    throw new Error("mapping runtime profiles must be read_only_navigation");
  }
  const allowed = new Set(profile.safetyPolicy.allowedActions ?? []);
  for (const step of [...profile.resetRecipe, ...profile.mappingRecipe]) {
    if (step.type !== "capture" && !allowed.has(step.type)) {
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
  if (step.type === "capture") return;
  if (!profile.safetyPolicy.allowedActions.includes(step.type)) {
    throw new Error(`action ${step.type} is not allowed for ${profile.appId}`);
  }
  if (step.type === "open_app" && params.packageName !== profile.packageName) {
    throw new Error("open_app packageName must match the runtime profile");
  }
  if (step.type === "intent_send") {
    if (params.packageName !== profile.packageName) {
      throw new Error("intent_send packageName must match the runtime profile");
    }
    if (params.action !== "android.intent.action.VIEW") {
      throw new Error("mapping intent_send only permits android.intent.action.VIEW");
    }
    const uri = String(params.uri ?? "");
    const parsed = new URL(uri);
    const hosts = profile.safetyPolicy.allowedUriHosts ?? [];
    if (parsed.protocol !== "https:" || !hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
      throw new Error(`URI host is not allowed by runtime profile: ${parsed.hostname}`);
    }
  }
}
