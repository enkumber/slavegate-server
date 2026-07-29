import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowCompositionRecord } from "../src/modules/workflow-segments/types";

const postgresUrl = process.env.GENERATED_WORKFLOW_PG_URL
  ?? process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let schema = "";
let previousDatabaseUrl: string | undefined;

describe("workflow execution binding lifecycle resolution", () => {
  beforeAll(async () => {
    if (postgresUrl === process.env.DATABASE_URL) {
      throw new Error("execution binding test database must not be the production DATABASE_URL");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `workflow_binding_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(postgresUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();

    const pool = new Pool({ connectionString: url.toString(), max: 2 });
    await pool.query(`
      CREATE TABLE lifecycle_state_definitions (
        lifecycle_key TEXT NOT NULL,
        status TEXT NOT NULL,
        initial BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (lifecycle_key, status)
      );
      CREATE TABLE lifecycle_resource_bindings (
        resource_table REGCLASS NOT NULL,
        lifecycle_key TEXT NOT NULL,
        state_column NAME NOT NULL,
        PRIMARY KEY (resource_table, state_column)
      );
      CREATE TABLE workflow_execution_bindings (
        request_key TEXT PRIMARY KEY,
        execution_key TEXT NOT NULL,
        composition_name TEXT NOT NULL,
        composition_version TEXT NOT NULL,
        composition_key TEXT NOT NULL,
        segment_refs JSONB NOT NULL,
        device_id UUID NOT NULL,
        account_id UUID NULL,
        intent TEXT NOT NULL,
        runtime_inputs JSONB NOT NULL,
        status TEXT NOT NULL,
        postcondition_verified BOOLEAN NOT NULL DEFAULT FALSE,
        result_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO lifecycle_state_definitions(lifecycle_key, status, initial, sort_order)
      VALUES ('fixture_execution', 'fixture_resolved', TRUE, 0);
      INSERT INTO lifecycle_resource_bindings(resource_table, lifecycle_key, state_column)
      VALUES ('workflow_execution_bindings'::regclass, 'fixture_execution', 'status');

      CREATE FUNCTION fixture_initial_execution_state()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.status IS NULL OR BTRIM(NEW.status) = '' THEN
          SELECT definition.status
            INTO NEW.status
            FROM lifecycle_resource_bindings binding
            JOIN lifecycle_state_definitions definition
              ON definition.lifecycle_key = binding.lifecycle_key
           WHERE binding.resource_table = TG_RELID
             AND binding.state_column = 'status'::name
             AND definition.initial
           ORDER BY definition.sort_order, definition.status
           LIMIT 1;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fixture_initial_execution_state
      BEFORE INSERT OR UPDATE ON workflow_execution_bindings
      FOR EACH ROW EXECUTE FUNCTION fixture_initial_execution_state();
    `);
    await pool.end();
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db/client");
    await closeDb();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("inserts and rebinds without requiring a lifecycle_key column on the resource row", async () => {
    const { workflowSegmentRepository } = await import(
      "../src/modules/workflow-segments/repository"
    );
    const composition = (version: string): WorkflowCompositionRecord => ({
      compositionName: "fixture_composition",
      version,
      compositionKey: version.repeat(24).slice(0, 24),
      capabilityKey: "fixture_capability",
      platform: "android",
      status: "candidate",
      inputSchema: { type: "object", required: [], properties: {} },
      outputSchema: { required: [], properties: {} },
      inputResolver: { version: "1", fields: {} },
      postconditionContract: {
        version: "1",
        all: [{
          left: { value: true },
          operator: "equals",
          operatorOpcode: 2,
          right: { value: true },
        }],
      },
      executionPolicy: {
        defaultVerificationStrategy: "local_only",
        dataRetentionDays: 1,
        runtimeContract: "edge-workflow/v2",
      },
      compatibility: {},
      nodes: [{
        nodeKey: "fixture",
        ordinal: 0,
        segmentKey: "fixture_segment",
        segmentVersion: version,
        inputBindings: {},
        outputBindings: {},
        dependsOn: [],
      }],
    });
    const common = {
      requestKey: "a".repeat(24),
      executionKey: "b".repeat(24),
      deviceId: "11111111-1111-4111-8111-111111111111",
      accountId: null,
      intent: "fixture",
      runtimeInputs: {},
      auditRuntimeInputs: {},
    };

    await workflowSegmentRepository.saveExecutionBinding({
      ...common,
      composition: composition("1"),
    });
    await workflowSegmentRepository.saveExecutionBinding({
      ...common,
      executionKey: "c".repeat(24),
      composition: composition("2"),
    });

    const result = await adminPool.query(
      `SELECT status, execution_key, composition_version
         FROM "${schema}".workflow_execution_bindings
        WHERE request_key = $1`,
      [common.requestKey],
    );
    expect(result.rows).toEqual([{
      status: "fixture_resolved",
      execution_key: "c".repeat(24),
      composition_version: "2",
    }]);
  });
});
