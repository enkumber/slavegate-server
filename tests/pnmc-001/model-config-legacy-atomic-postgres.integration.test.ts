import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelConfigService } from "../../src/modules/model-config/model-config.service";

const postgresUrl = process.env.PNMC001_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let pool: Pool;
let service: ModelConfigService;
let schema = "";
let previousEndpointAllowlist: string | undefined;

describe("PNMC-001 legacy vision config atomicity with real PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    const version = await adminPool.query<{ version: string }>("SELECT version()");
    expect(version.rows[0]?.version).toContain("PostgreSQL");

    schema = `pnmc_atomic_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: postgresUrl,
      max: 4,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`
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
      );
      CREATE FUNCTION reject_test_credential() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.credential_ref = 'env:VISION_REJECTED_KEY' THEN
          RAISE EXCEPTION 'test credential rejected' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_credential
      BEFORE INSERT OR UPDATE ON model_configs
      FOR EACH ROW EXECUTE FUNCTION reject_test_credential();
    `);
    service = new ModelConfigService(() => pool);
    previousEndpointAllowlist = process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST;
    process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "models.example.com";
  });

  beforeEach(async () => {
    service.invalidate();
    await pool.query("TRUNCATE model_configs");
    await pool.query(
      `INSERT INTO model_configs
        (role, provider, endpoint, model, api_key_encrypted, credential_ref, api_key_fingerprint, enabled, version)
       VALUES ('vision_vlm', 'openai_compatible', 'https://models.example.com/v1', 'vision-old',
               'enc:v1:old-secret', NULL, 'old-fingerprint', TRUE, 7)`,
    );
  });

  afterAll(async () => {
    if (previousEndpointAllowlist === undefined) delete process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST;
    else process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = previousEndpointAllowlist;
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("commits metadata and a credential-ref replacement as one versioned row mutation", async () => {
    const config = await service.updateLegacyVisionConfig({
      model: "vision-next",
      endpoint: "https://models.example.com/v1/chat/completions",
      credentialRef: "env:VISION_NEXT_KEY",
    });

    const row = await visionRow();
    expect(row).toMatchObject({
      model: "vision-next",
      endpoint: "https://models.example.com/v1",
      api_key_encrypted: null,
      credential_ref: "env:VISION_NEXT_KEY",
      api_key_fingerprint: null,
      version: 8,
    });
    expect(config).toMatchObject({
      model: "vision-next",
      hasCredential: true,
      credentialRefType: "env",
      version: 8,
    });
  });

  it("treats explicit null on a supported ref alias as an atomic clear, never as an ignored field", async () => {
    await service.updateLegacyVisionConfig({
      model: "vision-cleared",
      api_key_ref: null,
    });

    expect(await visionRow()).toMatchObject({
      model: "vision-cleared",
      api_key_encrypted: null,
      credential_ref: null,
      api_key_fingerprint: null,
      version: 8,
    });
  });

  it("rejects invalid refs and unsupported clear/direct-secret aliases with zero row mutation", async () => {
    const before = await visionRow();
    for (const payload of [
      { model: "invalid-ref", apiKeyRef: "env:../../VISION_KEY" },
      { model: "ignored-null", apiKey: null },
      { model: "ignored-clear", clearCredential: true },
      { model: "ignored-secret", credential: "opaque-secret" },
    ]) {
      await expect(service.updateLegacyVisionConfig(payload)).rejects.toMatchObject({ statusCode: 400 });
      expect(await visionRow()).toEqual(before);
    }
  });

  it("rolls back metadata and preserves the old secret when the credential write fails", async () => {
    const before = await visionRow();

    await expect(service.updateLegacyVisionConfig({
      provider: "openai_compatible",
      endpoint: "https://models.example.com/v1",
      model: "must-rollback",
      enabled: false,
      apiKeyRef: "env:VISION_REJECTED_KEY",
    })).rejects.toMatchObject({ code: "23514" });

    expect(await visionRow()).toEqual(before);
  });
});

async function visionRow(): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT role, provider, endpoint, model, api_key_encrypted, credential_ref,
            api_key_fingerprint, enabled, version
     FROM model_configs WHERE role = 'vision_vlm'`,
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
