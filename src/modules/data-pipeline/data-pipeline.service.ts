/**
 * data-pipeline/data-pipeline.service.ts
 * Extracted data storage, retention cleanup, and export.
 *
 * Extraction semantics are supplied by generated workflow classifiers and
 * PostgreSQL contracts. The server no longer boots application parsers.
 * Retention: cleanup job reads data_retention_days from workflow_templates
 */

import { getDb } from "../../db/client";
import type { ExtractedContent } from "./parser-interface";

// ─── Service ──────────────────────────────────────────────────────────────────

export class DataPipelineService {
  // ─── Retention cleanup ────────────────────────────────────────────────────

  /**
   * Delete extracted_data older than retention policy.
   * Run daily by scheduler (cron or BullMQ repeating job).
   *
   * Retention period comes from workflow_template.data_retention_days.
   * Default: 90 days.
   */
  async runRetentionCleanup(): Promise<{ deletedRows: number }> {
    const db = getDb();
    // Per-row retention: each row respects the retention policy of the workflow
    // that generated it (via workflow_id FK → workflow_templates).
    // NULL workflow_id falls back to 90 days.
    // Using MIN() across all templates was wrong — a 7-day test template would
    // delete data from 90-day templates too.
    const result = await db.query(
      `DELETE FROM extracted_data ed
       WHERE ed.created_at < NOW() - INTERVAL '1 day' * (
         COALESCE(
           (SELECT wt.data_retention_days
            FROM workflows w
            JOIN workflow_templates wt ON wt.id = w.template_id
            WHERE w.id = ed.workflow_id),
           90
         )
       )`
    );
    const deletedRows = result.rowCount ?? 0;
    console.log(`[data-pipeline] Retention cleanup: deleted ${deletedRows} rows`);
    return { deletedRows };
  }

  /**
   * Cleanup command_log older than 30 days (per Dan's decision).
   */
  async runCommandLogCleanup(): Promise<{ deletedRows: number }> {
    const db = getDb();
    const result = await db.query(
      "DELETE FROM command_log WHERE executed_at < NOW() - INTERVAL '30 days'"
    );
    const deletedRows = result.rowCount ?? 0;
    console.log(`[data-pipeline] Command log cleanup: deleted ${deletedRows} rows`);
    return { deletedRows };
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  async listExtractedData(
    platform?:   string,
    deviceId?:   string,
    contentType?: string,
    page = 1,
    pageSize = 100
  ): Promise<{ items: ExtractedContent[]; total: number }> {
    const db = getDb();
    const conditions: string[] = [];
    const values: unknown[] = [];

    const add = (col: string, val: unknown) => {
      values.push(val);
      conditions.push(`${col} = $${values.length}`);
    };
    if (platform)    add("platform",     platform);
    if (deviceId)    add("device_id",    deviceId);
    if (contentType) add("content_type", contentType);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(pageSize, (page - 1) * pageSize);

    const [rows, countRow] = await Promise.all([
      db.query(`SELECT * FROM extracted_data ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values),
      db.query(`SELECT COUNT(*) FROM extracted_data ${where}`, values.slice(0, -2)),
    ]);

    return {
      items: rows.rows.map(rowToContent),
      total: parseInt(countRow.rows[0].count, 10),
    };
  }
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

function rowToContent(row: Record<string, unknown>): ExtractedContent {
  return {
    platform:      row.platform as string,
    contentType:   row.content_type as ExtractedContent["contentType"],
    contentHash:   row.content_hash as string,
    author:        row.author as string,
    textContent:   (row.text_content as string) ?? null,
    engagement:    (row.engagement as Record<string, number>) ?? {},
    mediaUrls:     (row.media_urls as string[]) ?? [],
    confidence:    row.confidence as number,
    parserVersion: row.parser_version as string,
    rawData:       row.raw_data,
  };
}

export const dataPipelineService = new DataPipelineService();
