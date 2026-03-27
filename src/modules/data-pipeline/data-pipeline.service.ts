/**
 * data-pipeline/data-pipeline.service.ts
 * Extracted data storage, deduplication, retention cleanup, and export.
 *
 * Parser selection: parserRegistry.getCompatible(platform, appVersion)
 * Dedup: SHA256(platform + author + textContent) — contentHash unique per platform
 * Retention: cleanup job reads data_retention_days from workflow_templates
 */

import { getDb } from "../../db/client";
import { parserRegistry } from "./parser-registry";
import crypto from "crypto";
import type { ExtractedContent } from "./parser-interface";
import type { UiNode } from "./parser-interface";

// ─── Service ──────────────────────────────────────────────────────────────────

export class DataPipelineService {
  /**
   * Process extracted data from a workflow step.
   * Runs parser, deduplicates, stores.
   *
   * @param platform     "instagram" | "tiktok" | "reddit" | ...
   * @param appVersion   Device's installed app version
   * @param uiTree       Raw UI tree from ui_tree_dump job output
   * @param workflowId   Source workflow (for retention policy lookup)
   * @param deviceId     Source device
   */
  async processUiTreeData(
    platform:   string,
    appVersion: string,
    uiTree:     UiNode[],
    workflowId: string,
    deviceId:   string
  ): Promise<{ stored: number; duplicates: number }> {
    const parser = parserRegistry.getCompatible(platform, appVersion);
    if (!parser) {
      console.error(`[data-pipeline] No compatible parser for ${platform} v${appVersion}`);
      return { stored: 0, duplicates: 0 };
    }

    const contents = parser.parseUiTree(uiTree);
    return this.storeContents(contents, workflowId, deviceId);
  }

  /**
   * Process VLM output (fallback when UI tree parser fails).
   */
  async processVlmData(
    platform:   string,
    vlmResult:  { elements: unknown[]; sceneDescription: string; detectedState?: string | null },
    workflowId: string,
    deviceId:   string
  ): Promise<{ stored: number; duplicates: number }> {
    const parser = parserRegistry.get(platform);
    if (!parser) {
      console.error(`[data-pipeline] No parser for ${platform}`);
      return { stored: 0, duplicates: 0 };
    }

    const contents = parser.parseVlmOutput(vlmResult as Parameters<typeof parser.parseVlmOutput>[0]);
    return this.storeContents(contents, workflowId, deviceId);
  }

  // ─── Storage ───────────────────────────────────────────────────────────────

  private async storeContents(
    contents:   ExtractedContent[],
    workflowId: string,
    deviceId:   string
  ): Promise<{ stored: number; duplicates: number }> {
    const db = getDb();
    let stored = 0, duplicates = 0;

    for (const content of contents) {
      try {
        const result = await db.query(
          `INSERT INTO extracted_data
             (platform, content_type, content_hash, author, text_content,
              engagement, media_urls, confidence, parser_version, workflow_id, device_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (content_hash) DO NOTHING
           RETURNING id`,
          [
            content.platform,
            content.contentType,
            content.contentHash,
            content.author,
            content.textContent,
            JSON.stringify(content.engagement),
            JSON.stringify(content.mediaUrls),
            content.confidence,
            content.parserVersion,
            workflowId,
            deviceId,
          ]
        );
        if ((result.rowCount ?? 0) > 0) {
          stored++;
        } else {
          duplicates++;
        }
      } catch (err) {
        console.error(`[data-pipeline] Failed to store content ${content.contentHash}:`, (err as Error).message);
      }
    }

    if (stored > 0 || duplicates > 0) {
      console.log(`[data-pipeline] Stored: ${stored}, duplicates: ${duplicates}`);
    }
    return { stored, duplicates };
  }

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
