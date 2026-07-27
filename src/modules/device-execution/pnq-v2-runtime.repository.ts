import { Pool } from "pg";
import { getDb } from "../../db/client";
import type { PnqV2Job, PnqV2Node } from "./pnq-v2-contract";

export interface PnqV2LegacyMapping {
  legacyJobId: string;
  pnqJobId: string;
  pnqNodeId: string;
  attemptExecutionId: string | null;
  dispatchGeneration: number | null;
}

function db(pool?: Pool): Pool {
  return pool ?? getDb();
}

function toJob(row: Record<string, unknown>): PnqV2Job {
  return {
    id: row.id as string,
    nodeId: row.node_id as string,
    nodeSeq: Number(row.node_seq),
    requestKey: row.request_key as string,
    requestPayload: row.request_payload as Record<string, unknown>,
    status: row.status as PnqV2Job["status"],
    jobVersion: Number(row.job_version),
    dispatchGeneration: Number(row.dispatch_generation),
    executionId: (row.execution_id as string | null) ?? null,
    claimedConnectionEpoch: row.claimed_connection_epoch == null ? null : Number(row.claimed_connection_epoch),
    queueDeadlineAt: row.queue_deadline_at as Date,
    dispatchDeadlineAt: row.dispatch_deadline_at as Date,
    executionDeadlineAt: row.execution_deadline_at as Date,
    resultDeadlineAt: row.result_deadline_at as Date,
    terminalAt: (row.terminal_at as Date | null) ?? null,
    terminalReason: (row.terminal_reason as string | null) ?? null,
  };
}

export class PnqV2RuntimeRepository {
  constructor(private readonly pool?: Pool) {}

  async registerNode(nodeId: string, nodeKey = nodeId): Promise<PnqV2Node> {
    const result = await db(this.pool).query("SELECT * FROM pnq_register_node($1, $2, $3::jsonb)", [
      nodeId,
      nodeKey,
      JSON.stringify({ source: "pnq-v2-shadow-runtime" }),
    ]);
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      nodeKey: row.node_key as string,
      status: row.status as PnqV2Node["status"],
      nextNodeSeq: Number(row.next_node_seq),
      connectionEpoch: Number(row.connection_epoch),
      metadata: row.metadata as Record<string, unknown>,
    };
  }

  async bumpEpoch(nodeId: string, expectedEpoch: number): Promise<number> {
    const result = await db(this.pool).query("SELECT connection_epoch FROM pnq_bump_connection_epoch($1, $2)", [
      nodeId,
      expectedEpoch,
    ]);
    return Number(result.rows[0]?.connection_epoch ?? expectedEpoch);
  }

  async enqueueMappedJob(args: {
    legacyJobId: string;
    nodeId: string;
    payload: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<PnqV2LegacyMapping> {
    await this.registerNode(args.nodeId);
    const now = Date.now();
    const queue = new Date(now + Math.max(1_000, args.timeoutMs));
    const dispatch = new Date(queue.getTime() + Math.max(1_000, args.timeoutMs));
    const execution = new Date(dispatch.getTime() + Math.max(1_000, args.timeoutMs));
    const resultDeadline = new Date(execution.getTime() + Math.max(1_000, args.timeoutMs));
    const result = await db(this.pool).query(
      `WITH job AS (
         SELECT * FROM pnq_enqueue_job($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb)
       ), mapping AS (
         INSERT INTO pnq_legacy_job_map (legacy_job_id, pnq_job_id, pnq_node_id)
         SELECT $2, id, node_id FROM job
         ON CONFLICT (legacy_job_id) DO NOTHING
         RETURNING legacy_job_id, pnq_job_id, pnq_node_id, attempt_execution_id, dispatch_generation
       )
       SELECT m.legacy_job_id, m.pnq_job_id, m.pnq_node_id, m.attempt_execution_id, m.dispatch_generation
       FROM mapping m
       UNION ALL
       SELECT m.legacy_job_id, m.pnq_job_id, m.pnq_node_id, m.attempt_execution_id, m.dispatch_generation
       FROM pnq_legacy_job_map m
       WHERE m.legacy_job_id = $2
         AND NOT EXISTS (SELECT 1 FROM mapping)`,
      [
        args.nodeId,
        args.legacyJobId,
        JSON.stringify(args.payload),
        queue,
        dispatch,
        execution,
        resultDeadline,
        JSON.stringify({ legacyJobId: args.legacyJobId }),
      ],
    );
    return this.mapRow(result.rows[0]);
  }

  async claimAndStart(legacyJobId: string, epoch: number, executionId: string): Promise<PnqV2LegacyMapping | null> {
    const mapping = await this.mappingForLegacyJob(legacyJobId);
    if (!mapping) return null;
    const claimed = await db(this.pool).query("SELECT * FROM pnq_claim_next_job($1, $2, $3, $4)", [
      mapping.pnqNodeId,
      epoch,
      executionId,
      "pnq-v2-shadow-runtime",
    ]);
    const claimedJob = claimed.rows[0] ? toJob(claimed.rows[0]) : null;
    if (!claimedJob || claimedJob.id !== mapping.pnqJobId) return mapping;
    const started = await db(this.pool).query("SELECT * FROM pnq_start_execution($1, $2, $3, $4, $5, $6)", [
      claimedJob.id,
      epoch,
      claimedJob.jobVersion,
      claimedJob.dispatchGeneration,
      executionId,
      "pnq-v2-shadow-runtime",
    ]);
    const job = toJob(started.rows[0]);
    await db(this.pool).query(
      `UPDATE pnq_legacy_job_map
       SET attempt_execution_id = $2, dispatch_generation = $3, socket_epoch = $4, updated_at = NOW()
       WHERE legacy_job_id = $1`,
      [legacyJobId, executionId, job.dispatchGeneration, epoch],
    );
    return { ...mapping, attemptExecutionId: executionId, dispatchGeneration: job.dispatchGeneration };
  }

  async recordResult(legacyJobId: string, epoch: number, success: boolean, resultPayload: Record<string, unknown>): Promise<PnqV2Job | null> {
    const mapping = await this.mappingForLegacyJob(legacyJobId);
    if (!mapping?.attemptExecutionId || mapping.dispatchGeneration == null) return null;
    const result = await db(this.pool).query("SELECT * FROM pnq_record_result($1, $2, $3, $4, $5, $6::jsonb, $7)", [
      mapping.pnqJobId,
      mapping.attemptExecutionId,
      epoch,
      mapping.dispatchGeneration,
      success,
      JSON.stringify(resultPayload),
      "pnq-v2-shadow-runtime",
    ]);
    return toJob(result.rows[0]);
  }

  async markExpiredActiveStuck(reason: string, now = new Date()): Promise<number> {
    const pool = db(this.pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<{
        id: string;
        status: string;
        job_version: string;
        dispatch_generation: string;
        dispatch_deadline_at: Date;
        result_deadline_at: Date;
      }>(
        `SELECT job.id, job.status, job.job_version, job.dispatch_generation,
                job.dispatch_deadline_at, job.result_deadline_at
         FROM pnq_jobs job
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('pnq_jobs')
          AND binding.state_column = 'status'::name
         JOIN lifecycle_state_definitions state
           ON state.lifecycle_key = binding.lifecycle_key
          AND state.status = job.status
         WHERE NOT state.initial
           AND NOT state.terminal
           AND (
             (
               job.dispatch_started_at IS NOT NULL
               AND job.execution_started_at IS NULL
               AND job.dispatch_deadline_at <= $1
             )
             OR (
               job.execution_started_at IS NOT NULL
               AND job.result_deadline_at <= $1
             )
           )
         ORDER BY job.node_id, job.node_seq
         FOR UPDATE OF job SKIP LOCKED`,
        [now],
      );
      let marked = 0;
      for (const row of expired.rows) {
        const result = await client.query("SELECT terminal_at IS NOT NULL AS terminal FROM pnq_mark_stuck($1, $2, $3::jsonb, $4)", [
          row.id,
          reason,
          JSON.stringify({
            source: "pnq-v2-shadow-runtime",
            expiredAt: now.toISOString(),
            observedStatus: row.status,
            observedJobVersion: Number(row.job_version),
            observedDispatchGeneration: Number(row.dispatch_generation),
            observedDispatchDeadlineAt: row.dispatch_deadline_at,
            observedResultDeadlineAt: row.result_deadline_at,
          }),
          "pnq-v2-shadow-runtime",
        ]);
        if (result.rows[0]?.terminal === true) marked += 1;
      }
      await client.query("COMMIT");
      return marked;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async mappingForLegacyJob(legacyJobId: string): Promise<PnqV2LegacyMapping | null> {
    const result = await db(this.pool).query(
      `SELECT legacy_job_id, pnq_job_id, pnq_node_id, attempt_execution_id, dispatch_generation
       FROM pnq_legacy_job_map WHERE legacy_job_id = $1`,
      [legacyJobId],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private mapRow(row: Record<string, unknown>): PnqV2LegacyMapping {
    return {
      legacyJobId: row.legacy_job_id as string,
      pnqJobId: row.pnq_job_id as string,
      pnqNodeId: row.pnq_node_id as string,
      attemptExecutionId: (row.attempt_execution_id as string | null) ?? null,
      dispatchGeneration: row.dispatch_generation == null ? null : Number(row.dispatch_generation),
    };
  }
}
