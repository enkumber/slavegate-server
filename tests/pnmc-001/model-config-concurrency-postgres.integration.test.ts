import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelConfigService, type ModelRole } from "../../src/modules/model-config/model-config.service";

const postgresUrl = process.env.PNMC001_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let metadataPool: Pool;
let credentialPool: Pool;
let schema = "";
let credentialApplicationName = "";
let previousEndpointAllowlist: string | undefined;

describe("PNMC-001 model config concurrency with real PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    const version = await adminPool.query<{ version: string }>("SELECT version()");
    expect(version.rows[0]?.version).toContain("PostgreSQL");

    schema = `pnmc_concurrency_${process.pid}_${Date.now()}`;
    credentialApplicationName = `${schema}_credential`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    metadataPool = new Pool({
      connectionString: postgresUrl,
      max: 2,
      application_name: `${schema}_metadata`,
      options: `-c search_path=${schema}`,
    });
    credentialPool = new Pool({
      connectionString: postgresUrl,
      max: 2,
      application_name: credentialApplicationName,
      options: `-c search_path=${schema}`,
    });
    await metadataPool.query(`
      CREATE TABLE model_configs (
        role TEXT PRIMARY KEY CHECK (role IN ('decision_llm', 'vision_vlm')),
        provider TEXT NOT NULL,
        endpoint TEXT,
        model TEXT NOT NULL,
        api_key_encrypted TEXT,
        credential_ref TEXT,
        api_key_fingerprint TEXT,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        version INT NOT NULL DEFAULT 1,
        last_test_status TEXT,
        last_test_message TEXT,
        last_test_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    previousEndpointAllowlist = process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST;
    process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "models.example.com";
  });

  beforeEach(async () => {
    await metadataPool.query("TRUNCATE model_configs");
  });

  afterAll(async () => {
    if (previousEndpointAllowlist === undefined) delete process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST;
    else process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = previousEndpointAllowlist;
    await metadataPool?.end();
    await credentialPool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("serializes absent-row legacy writers and preserves the credential writer's coherent state", async () => {
    const barrier = createSnapshotBarrier(metadataPool, "vision_vlm");
    const metadataService = new ModelConfigService(barrier.provider);
    const credentialService = new ModelConfigService(() => credentialPool);

    const metadataMutation = metadataService.updateLegacyVisionConfig({
      provider: "openai_compatible",
      endpoint: "https://models.example.com/v1",
      model: "vision-metadata-first",
      enabled: true,
    });
    await barrier.snapshotReached;

    let credentialSettled = false;
    const credentialMutation = credentialService.updateLegacyVisionConfig({
      provider: "openai_compatible",
      endpoint: "https://models.example.com/v1",
      model: "vision-credential-second",
      enabled: true,
      credentialRef: "env:VISION_CONCURRENT_KEY",
    }).finally(() => {
      credentialSettled = true;
    });

    const state = await waitForCredentialWriter(credentialApplicationName, () => credentialSettled);
    barrier.releaseSnapshot();
    await Promise.all([metadataMutation, credentialMutation]);

    expect(state).toBe("blocked_on_role_lock");
    expect(await configRow("vision_vlm")).toMatchObject({
      model: "vision-credential-second",
      api_key_encrypted: null,
      credential_ref: "env:VISION_CONCURRENT_KEY",
      api_key_fingerprint: null,
      enabled: true,
      version: 2,
    });
  }, 10_000);

  it("serializes generic metadata against credential replacement without a stale credential UPSERT", async () => {
    await metadataPool.query(
      `INSERT INTO model_configs
         (role, provider, endpoint, model, credential_ref, enabled, version)
       VALUES ('decision_llm', 'openai_compatible', 'https://models.example.com/v1',
               'decision-old', 'env:DECISION_OLD_KEY', TRUE, 7)`,
    );
    const barrier = createSnapshotBarrier(metadataPool, "decision_llm");
    const metadataService = new ModelConfigService(barrier.provider);
    const credentialService = new ModelConfigService(() => credentialPool);

    const metadataMutation = metadataService.update("decision_llm", {
      model: "decision-metadata-final",
    });
    await barrier.snapshotReached;

    let credentialSettled = false;
    const credentialMutation = credentialService.updateCredential("decision_llm", {
      credentialRef: "env:DECISION_CONCURRENT_KEY",
    }).finally(() => {
      credentialSettled = true;
    });

    const state = await waitForCredentialWriter(credentialApplicationName, () => credentialSettled);
    barrier.releaseSnapshot();
    await Promise.all([metadataMutation, credentialMutation]);

    expect(state).toBe("blocked_on_role_lock");
    expect(await configRow("decision_llm")).toMatchObject({
      model: "decision-metadata-final",
      credential_ref: "env:DECISION_CONCURRENT_KEY",
      api_key_encrypted: null,
      api_key_fingerprint: null,
      enabled: true,
      version: 9,
    });
  }, 10_000);
});

function createSnapshotBarrier(pool: Pool, expectedRole: ModelRole): {
  provider: () => Pick<Pool, "query" | "connect">;
  snapshotReached: Promise<void>;
  releaseSnapshot: () => void;
} {
  let snapshotReachedResolve!: () => void;
  let releaseSnapshotResolve!: () => void;
  let paused = false;
  const snapshotReached = new Promise<void>((resolve) => {
    snapshotReachedResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseSnapshotResolve = resolve;
  });

  const queryWithBarrier = async (
    queryable: Pick<PoolClient, "query">,
    sql: string,
    params?: unknown[],
  ): Promise<unknown> => {
    const result = await queryable.query(sql, params);
    const normalized = sql.trim().replace(/\s+/g, " ");
    if (!paused
      && normalized.startsWith("SELECT * FROM model_configs WHERE role = $1")
      && params?.[0] === expectedRole) {
      paused = true;
      snapshotReachedResolve();
      await released;
    }
    return result;
  };

  return {
    provider: () => ({
      query: ((sql: string, params?: unknown[]) => queryWithBarrier(pool, sql, params)) as Pool["query"],
      connect: (async () => {
        const client = await pool.connect();
        return {
          query: ((sql: string, params?: unknown[]) => queryWithBarrier(client, sql, params)) as PoolClient["query"],
          release: client.release.bind(client),
        } as PoolClient;
      }) as Pool["connect"],
    }),
    snapshotReached,
    releaseSnapshot: releaseSnapshotResolve,
  };
}

async function waitForCredentialWriter(
  applicationName: string,
  settled: () => boolean,
): Promise<"blocked_on_role_lock" | "completed_without_lock"> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (settled()) return "completed_without_lock";
    const result = await adminPool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE application_name = $1
           AND wait_event_type = 'Lock'
           AND query LIKE '%pg_advisory_xact_lock%'
       ) AS blocked`,
      [applicationName],
    );
    if (result.rows[0]?.blocked) return "blocked_on_role_lock";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("credential writer neither blocked on the role lock nor completed");
}

async function configRow(role: ModelRole): Promise<Record<string, unknown>> {
  const result = await metadataPool.query(
    `SELECT role, provider, endpoint, model, api_key_encrypted, credential_ref,
            api_key_fingerprint, enabled, version
     FROM model_configs WHERE role = $1`,
    [role],
  );
  return result.rows[0];
}

function assertSafeTestDatabase(rawUrl: string): void {
  if (rawUrl === process.env.DATABASE_URL) {
    throw new Error("PNMC001_PG_URL must not be the production DATABASE_URL");
  }
  const parsed = new URL(rawUrl);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(pnmc.*test|test.*pnmc|pnmc001|pnq.*test|test.*pnq|pnq001|vitest|tmp)/i.test(dbName)) {
    throw new Error(`Refusing to use PostgreSQL database "${dbName}". Use a disposable PNMC/PNQ/test database.`);
  }
}
