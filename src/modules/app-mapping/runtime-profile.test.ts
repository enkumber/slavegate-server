import { describe, expect, it } from "vitest";
import {
  assertRuntimeActionSafe,
  renderRuntimeParams,
  runtimeProfileFromRow,
  runtimeStateDetectionOverrides,
  validateRuntimeProfile,
  type AppRuntimeProfile,
} from "./runtime-profile";

function profile(): AppRuntimeProfile {
  return {
    appId: "com.example.app",
    appName: "Example",
    packageName: "com.example.app",
    profileVersion: 1,
    resetRecipe: [{ id: "open", type: "open_app", params: { packageName: "{{packageName}}" } }],
    mappingRecipe: [
      { id: "home", type: "capture", stateKey: "home", name: "Home" },
      { id: "detail", type: "intent_send", params: { action: "android.intent.action.VIEW", uri: "{{input.uri}}", packageName: "{{packageName}}" } },
    ],
    safetyPolicy: {
      mode: "read_only_navigation",
      allowedActions: ["open_app", "intent_send"],
      allowedUriHosts: ["example.com"],
    },
    metadata: {},
  };
}

describe("app runtime profiles", () => {
  it("loads and validates JSONB rows without app-specific runtime constants", () => {
    const loaded = runtimeProfileFromRow({
      app_id: "com.example.app",
      app_name: "Example",
      package_name: "com.example.app",
      profile_version: 3,
      reset_recipe: JSON.stringify(profile().resetRecipe),
      mapping_recipe: profile().mappingRecipe,
      safety_policy: profile().safetyPolicy,
      default_device_id: null,
      metadata: { source: "postgresql" },
    });

    expect(loaded).toMatchObject({
      appId: "com.example.app",
      packageName: "com.example.app",
      profileVersion: 3,
      metadata: { source: "postgresql" },
    });
  });

  it("renders only supported package/input templates", () => {
    expect(renderRuntimeParams(
      { packageName: "{{packageName}}", uri: "{{input.uri}}" },
      profile(),
      { uri: "https://example.com/detail" },
    )).toEqual({ packageName: "com.example.app", uri: "https://example.com/detail" });
    expect(() => renderRuntimeParams("{{unknown}}", profile(), {})).toThrow("unsupported runtime profile template");
  });

  it("fails closed for actions outside the profile policy", () => {
    const invalid = profile();
    invalid.mappingRecipe.push({ id: "tap", type: "a11y_find_tap", params: { text: "Delete" } });
    expect(() => validateRuntimeProfile(invalid)).toThrow("is not allowed by its safety policy");
  });

  it("loads DB-owned state detection overrides without application constants", () => {
    expect(runtimeStateDetectionOverrides({
      stateDetectionOverrides: {
        search_entry: {
          forbiddenAnchors: ["resourceId:search_surface", "resourceId:search_surface"],
          optionalAnchors: ["contentDescription:Search"],
        },
      },
    })).toEqual({
      search_entry: {
        requiredAnchors: undefined,
        optionalAnchors: ["contentDescription:Search"],
        forbiddenAnchors: ["resourceId:search_surface"],
      },
    });
    expect(() => runtimeStateDetectionOverrides({
      stateDetectionOverrides: { search_entry: { forbiddenAnchors: "bad" } },
    })).toThrow("must be an array");
  });

  it("permits only HTTPS VIEW intents to allowlisted hosts and the configured package", () => {
    const step = profile().mappingRecipe[1];
    expect(() => assertRuntimeActionSafe(profile(), step, {
      action: "android.intent.action.VIEW",
      uri: "https://example.com/detail",
      packageName: "com.example.app",
    })).not.toThrow();
    expect(() => assertRuntimeActionSafe(profile(), step, {
      action: "android.intent.action.VIEW",
      uri: "https://evil.example/detail",
      packageName: "com.example.app",
    })).toThrow("URI host is not allowed");
    expect(() => assertRuntimeActionSafe(profile(), step, {
      action: "android.intent.action.SEND",
      uri: "https://example.com/detail",
      packageName: "com.example.app",
    })).toThrow("only permits android.intent.action.VIEW");
  });
});
