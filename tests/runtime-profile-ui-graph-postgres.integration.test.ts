import express from "express";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const postgresUrl = process.env.RUNTIME_PROFILE_UI_GRAPH_PG_URL
  ?? process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

const API_KEY = "runtime-profile-ui-graph-test-key";
const APP_ID = "com.reddit.frontpage";

let adminPool: Pool;
let pool: Pool;
let schema = "";
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalApiKey = process.env.API_KEY;
const originalJwtSecret = process.env.JWT_SECRET;

vi.mock("../src/transport/transport", () => ({
  isDeviceOnline: vi.fn(() => false),
  sendStandaloneJobToDevice: vi.fn(() => {
    throw new Error("device execution must not be reached by materialization tests");
  }),
  waitForResult: vi.fn(),
}));

describe("runtime profile override UI graph materialization PostgreSQL contract", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 4 });
    await assertRealPostgres(adminPool);
    schema = `runtime_profile_ui_graph_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);

    process.env.API_KEY = API_KEY;
    process.env.JWT_SECRET = "runtime-profile-ui-graph-test-jwt";
    process.env.DATABASE_URL = withSearchPath(postgresUrl, schema);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

    await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/schema.sql"), "utf8"));
    for (const migration of [
      "027_app_maps.sql",
      "087_ui_graph_runtime.sql",
      "088_app_runtime_profiles.sql",
      "089_runtime_profile_state_detection_overrides.sql",
    ]) {
      await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/migrations", migration), "utf8"));
    }
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app_maps, ui_graph_transitions, ui_graph_selectors, ui_graph_state_variants, ui_graph_states RESTART IDENTITY CASCADE");
    await pool.query(
      `UPDATE app_runtime_profiles
          SET profile_version = 2,
              metadata = '{"seed":"089_runtime_profile_state_detection_overrides.sql","operationalSource":"postgresql","stateDetectionOverrides":{"reddit_search_entry":{"forbiddenAnchors":["resourceId:search_bar","resourceId:search_bar_top_app_bar"]}}}'::jsonb,
              active = TRUE,
              updated_at = NOW()
        WHERE app_id = $1`,
      [APP_ID],
    );
    await insertRawAppMap();
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db/client");
    await closeDb();
    await pool?.end();
    restoreEnv("DATABASE_URL", originalDatabaseUrl);
    restoreEnv("API_KEY", originalApiKey);
    restoreEnv("JWT_SECRET", originalJwtSecret);
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("materializes active profile v2 required, optional, and forbidden overrides idempotently", async () => {
    const { materializeAllLegacyAppMaps } = await import("../src/modules/ui-graph/materializer");

    const first = await materializeAllLegacyAppMaps();
    const second = await materializeAllLegacyAppMaps();

    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second).toMatchObject({ apps: 1, states: 2, variants: 2 });

    const variant = await searchEntryVariant();
    expect(variant.required_anchors).toEqual(["contentDescription:Search Reddit", "resourceId:main_top_app_bar_search"]);
    expect(variant.optional_anchors).toEqual(["text:Search"]);
    expect(variant.forbidden_anchors).toEqual(["resourceId:search_bar", "resourceId:search_bar_top_app_bar"]);
    expect(variant.metadata).toMatchObject({
      source: "legacy_app_map",
      appMapVersion: "raw-map-v1",
      runtimeProfile: { version: 2, source: "postgresql" },
    });
    expect(variant.metadata.runtimeProfile.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("applies the newest saved profile version deterministically on rematerialization", async () => {
    const { materializeAllLegacyAppMaps } = await import("../src/modules/ui-graph/materializer");
    await materializeAllLegacyAppMaps();
    await pool.query(
      `UPDATE app_runtime_profiles
          SET profile_version = 3,
              metadata = '{"seed":"test","operationalSource":"postgresql","stateDetectionOverrides":{"reddit_search_entry":{"requiredAnchors":["resourceId:secondary_required","resourceId:main_top_app_bar_search"],"optionalAnchors":["text:Search","text:Recent"],"forbiddenAnchors":["resourceId:search_bar","resourceId:search_bar"]}}}'::jsonb,
              updated_at = NOW()
        WHERE app_id = $1`,
      [APP_ID],
    );

    await materializeAllLegacyAppMaps();
    await materializeAllLegacyAppMaps();

    const variant = await searchEntryVariant();
    expect(variant.required_anchors).toEqual([
      "contentDescription:Search Reddit",
      "resourceId:main_top_app_bar_search",
      "resourceId:secondary_required",
    ]);
    expect(variant.optional_anchors).toEqual(["text:Recent", "text:Search"]);
    expect(variant.forbidden_anchors).toEqual(["resourceId:search_bar"]);
    expect(variant.metadata.runtimeProfile.version).toBe(3);
  });

  it("projects the same authoritative materialized anchors from mapping and ui-graph endpoints", async () => {
    const { materializeAllLegacyAppMaps } = await import("../src/modules/ui-graph/materializer");
    await materializeAllLegacyAppMaps();

    const mapping = await getJson("/api/mapping/com.reddit.frontpage");
    const graph = await getJson("/api/ui-graph/states?appId=com.reddit.frontpage");

    expect(mapping.status, JSON.stringify(mapping.body)).toBe(200);
    expect(graph.status, JSON.stringify(graph.body)).toBe(200);
    expect(mapping.body.map.pages.reddit_search_entry.detection.forbiddenAnchors).toEqual([
      "resourceId:search_bar",
      "resourceId:search_bar_top_app_bar",
    ]);
    expect(mapping.body.provenance.runtimeProfile).toMatchObject({ version: 2, source: "postgresql" });

    const state = graph.body.data.states.find((entry: any) => entry.key === "reddit_search_entry");
    expect(state.variants[0].forbiddenAnchors).toEqual([
      "resourceId:search_bar",
      "resourceId:search_bar_top_app_bar",
    ]);
    expect(state.variants[0].metadata.runtimeProfile).toMatchObject({ version: 2, source: "postgresql" });
  });

  it("keeps device-backed refresh fail-closed without dispatching around the queue invariant", async () => {
    const { sendStandaloneJobToDevice } = await import("../src/transport/transport");
    const response = await postJson("/api/mapping/refresh/com.reddit.frontpage", {});

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("server-side only");
    expect(sendStandaloneJobToDevice).not.toHaveBeenCalled();
  });
});

async function searchEntryVariant(): Promise<any> {
  const result = await pool.query(
    `SELECT v.required_anchors, v.optional_anchors, v.forbidden_anchors, v.metadata
       FROM ui_graph_states s
       JOIN ui_graph_state_variants v ON v.state_id = s.id
      WHERE s.app_id = $1 AND s.state_key = 'reddit_search_entry' AND v.variant_key = 'default'`,
    [APP_ID],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

async function insertRawAppMap(): Promise<void> {
  const map = {
    appId: APP_ID,
    appName: "Reddit",
    version: "raw-map-v1",
    appVersion: "2026.20.1",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    pageCount: 2,
    transitionCount: 1,
    pages: {
      reddit_home_feed: {
        name: "Reddit home/feed",
        discoveryOrder: 0,
        detection: {
          method: "ui_tree_signature",
          signatureHash: "hash-home",
          anchors: ["resourceId:home_feed"],
          optionalAnchors: [],
          forbiddenAnchors: [],
        },
        elements: {
          main_top_app_bar_search: {
            resourceId: "main_top_app_bar_search",
            contentDescription: "Search Reddit",
            text: "",
            className: "android.widget.Button",
            bounds: { x: 0.1, y: 0.03, w: 0.8, h: 0.04 },
            leadsTo: "reddit_search_entry",
          },
        },
      },
      reddit_search_entry: {
        name: "Reddit search entry",
        discoveryOrder: 1,
        detection: {
          method: "ui_tree_signature",
          signatureHash: "hash-search-entry",
          anchors: ["contentDescription:Search Reddit", "resourceId:main_top_app_bar_search"],
          optionalAnchors: ["text:Search"],
          forbiddenAnchors: [],
        },
        elements: {
          input: {
            resourceId: "search_input",
            contentDescription: "Search Reddit",
            text: "Search",
            className: "android.widget.EditText",
            bounds: { x: 0.1, y: 0.03, w: 0.8, h: 0.04 },
            leadsTo: "self",
          },
        },
      },
    },
  };
  await pool.query(
    `INSERT INTO app_maps (app_id, app_name, map_data, version, page_count, transition_count)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [APP_ID, "Reddit", JSON.stringify(map), map.version, map.pageCount, map.transitionCount],
  );
}

async function app() {
  const app = express();
  app.use(express.json());
  const mappingRoutes = await import("../src/modules/app-mapping/mapping-routes");
  const uiGraphRoutes = await import("../src/modules/ui-graph/routes");
  app.use("/api/mapping", mappingRoutes.default);
  app.use("/api/ui-graph", uiGraphRoutes.default);
  return app;
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const server = await app();
  return requestJson(server, "GET", pathname);
}

async function postJson(pathname: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const server = await app();
  return requestJson(server, "POST", pathname, body);
}

async function requestJson(
  server: express.Express,
  method: "GET" | "POST",
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
          method,
          headers: { "content-type": "application/json", "x-api-key": API_KEY },
          body: body ? JSON.stringify(body) : undefined,
        });
        resolve({ status: response.status, body: await response.json() });
      } catch (err) {
        reject(err);
      } finally {
        listener.close();
      }
    });
  });
}

function withSearchPath(rawUrl: string, searchPath: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("options", `-c search_path=${searchPath}`);
  return url.toString();
}

function assertSafeTestDatabase(url: string): void {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error(`Refusing to run PostgreSQL integration test against non-local host: ${parsed.hostname}`);
  }
  if (!/(test|pnq)/i.test(parsed.pathname)) {
    throw new Error(`Refusing to run PostgreSQL integration test against suspicious database: ${parsed.pathname}`);
  }
}

async function assertRealPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{ version: string }>("SELECT version()");
  expect(result.rows[0]?.version).toContain("PostgreSQL");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
