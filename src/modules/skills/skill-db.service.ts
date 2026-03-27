/**
 * skills/skill-db.service.ts
 * Persistent coordinate cache for cascade-tap L1.5.
 *
 * Table: coordinate_cache (migrations 020 + 020b)
 * All writes are fire-and-forget — never block tap execution.
 */

import { getDb } from "../../db/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeviceInfo {
  app:             string;
  appVersion:      string;
  resolution:      string;
  density?:        number;
  deviceClass?:    "phone" | "tablet" | "foldable";
  orientation?:    "portrait" | "landscape";
  fontScaleBucket?: "small" | "normal" | "large" | "xlarge";
}

export interface CachedCoord {
  id:           number;
  x:            number;
  y:            number;
  width:        number | null;
  height:       number | null;
  confidence:   number;
  learnMethod:  string;
  successCount: number;
  failCount:    number;
}

export interface LearnCoordInput {
  deviceInfo:  DeviceInfo;
  screenType:  string;      // e.g. 'own_profile', 'following_list', 'unknown'
  elementName: string;      // e.g. 'nav.home', 'profile.following_count'
  x:           number;      // normalized 0.0-1.0
  y:           number;      // normalized 0.0-1.0
  width?:      number;
  height?:     number;
  learnMethod: "ui_tree" | "ocr" | "vlm" | "manual";
  confidence:  number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

class CoordCacheService {

  /**
   * L1.5 lookup — returns null on miss or confidence below threshold.
   * Updates last_used_at fire-and-forget on hit.
   */
  async getCoord(
    deviceInfo:    DeviceInfo,
    screenType:    string,
    elementName:   string,
    minConfidence: number = 0.7,
  ): Promise<CachedCoord | null> {
    const db = getDb();
    try {
      const result = await db.query(
        `SELECT id, x, y, width, height, confidence, learn_method,
                success_count, fail_count
         FROM coordinate_cache
         WHERE app               = $1
           AND app_version       = $2
           AND resolution        = $3
           AND device_class      = $4
           AND orientation       = $5
           AND font_scale_bucket = $6
           AND screen_type_key   = $7
           AND element_name      = $8
           AND confidence        >= $9
         ORDER BY confidence DESC, last_success_at DESC
         LIMIT 1`,
        [
          deviceInfo.app,
          deviceInfo.appVersion,
          deviceInfo.resolution,
          deviceInfo.deviceClass      || "phone",
          deviceInfo.orientation      || "portrait",
          deviceInfo.fontScaleBucket  || "normal",
          screenType,
          elementName,
          minConfidence,
        ],
      );

      if (result.rows.length === 0) return null;

      const r = result.rows[0] as Record<string, unknown>;

      // Fire-and-forget last_used_at touch
      this.touchLastUsed(r.id as number).catch(() => {});

      return {
        id:           r.id as number,
        x:            r.x as number,
        y:            r.y as number,
        width:        r.width as number | null,
        height:       r.height as number | null,
        confidence:   r.confidence as number,
        learnMethod:  r.learn_method as string,
        successCount: r.success_count as number,
        failCount:    r.fail_count as number,
      };
    } catch (err) {
      console.error("[coord-cache] getCoord error:", (err as Error).message);
      return null;
    }
  }

  async touchLastUsed(coordId: number): Promise<void> {
    try {
      await getDb().query(
        `UPDATE coordinate_cache SET last_used_at = NOW() WHERE id = $1`,
        [coordId],
      );
    } catch { /* non-fatal */ }
  }

  /**
   * UPSERT coordinate after successful L2/L2.5/L3 tap.
   * Only overwrites coords if new confidence >= existing confidence.
   */
  async learnCoord(input: LearnCoordInput): Promise<void> {
    // B3 guard: reject nav.* coordinates with y > 0.94 (Android system nav bar zone).
    // Instagram nav bar is at y≈0.912. y > 0.94 is the Android home/back/recents bar.
    // Any such coordinate hitting our DB is contaminated and must never be stored.
    if (input.elementName.startsWith("nav.") && input.y > 0.94) {
      console.warn(`[coord-cache] B3: Rejecting contaminated nav coord ${input.elementName} y=${input.y.toFixed(3)} (> 0.94 = Android nav bar zone)`);
      return;
    }
    try {
      await getDb().query(
        `INSERT INTO coordinate_cache
           (app, app_version, resolution, density, device_class, orientation,
            font_scale_bucket, screen_type_key, element_name,
            x, y, width, height, confidence, learn_method,
            success_count, last_used_at, last_success_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, 1, NOW(), NOW())
         ON CONFLICT (app, app_version, resolution, device_class, orientation,
                      font_scale_bucket, screen_type_key, element_name)
         DO UPDATE SET
           x             = CASE WHEN EXCLUDED.confidence >= coordinate_cache.confidence
                             THEN EXCLUDED.x ELSE coordinate_cache.x END,
           y             = CASE WHEN EXCLUDED.confidence >= coordinate_cache.confidence
                             THEN EXCLUDED.y ELSE coordinate_cache.y END,
           width         = CASE WHEN EXCLUDED.confidence >= coordinate_cache.confidence
                             THEN EXCLUDED.width ELSE coordinate_cache.width END,
           height        = CASE WHEN EXCLUDED.confidence >= coordinate_cache.confidence
                             THEN EXCLUDED.height ELSE coordinate_cache.height END,
           confidence    = GREATEST(EXCLUDED.confidence, coordinate_cache.confidence),
           learn_method  = CASE WHEN EXCLUDED.confidence >= coordinate_cache.confidence
                             THEN EXCLUDED.learn_method ELSE coordinate_cache.learn_method END,
           last_used_at  = NOW(),
           last_success_at = NOW()`,
        [
          input.deviceInfo.app,
          input.deviceInfo.appVersion,
          input.deviceInfo.resolution,
          input.deviceInfo.density        ?? null,
          input.deviceInfo.deviceClass    || "phone",
          input.deviceInfo.orientation    || "portrait",
          input.deviceInfo.fontScaleBucket || "normal",
          input.screenType,
          input.elementName,
          input.x,
          input.y,
          input.width  ?? null,
          input.height ?? null,
          input.confidence,
          input.learnMethod,
        ],
      );
    } catch (err) {
      console.error("[coord-cache] learnCoord error:", (err as Error).message);
    }
  }

  /**
   * Increment success count + recalculate confidence.
   * Fire-and-forget safe.
   */
  async incrementSuccess(coordId: number): Promise<void> {
    try {
      await getDb().query(
        `UPDATE coordinate_cache SET
           success_count   = success_count + 1,
           confidence      = (success_count + 1)::REAL
                             / (success_count + 1 + fail_count)::REAL,
           last_success_at = NOW(),
           last_used_at    = NOW()
         WHERE id = $1`,
        [coordId],
      );
    } catch (err) {
      console.error("[coord-cache] incrementSuccess error:", (err as Error).message);
    }
  }

  /**
   * Increment fail count + recalculate confidence.
   * Auto-deletes if confidence < 0.5 AND samples > 5.
   * Returns new confidence or null if entry was auto-deleted.
   */
  async incrementFail(coordId: number): Promise<number | null> {
    const db = getDb();
    try {
      const result = await db.query(
        `UPDATE coordinate_cache SET
           fail_count   = fail_count + 1,
           confidence   = success_count::REAL
                          / (success_count + fail_count + 1)::REAL,
           last_used_at = NOW()
         WHERE id = $1
         RETURNING confidence, success_count, fail_count`,
        [coordId],
      );

      if (result.rows.length === 0) return null;

      const { confidence, success_count, fail_count } =
        result.rows[0] as { confidence: number; success_count: number; fail_count: number };

      if (confidence < 0.5 && (success_count + fail_count) > 5) {
        await db.query(`DELETE FROM coordinate_cache WHERE id = $1`, [coordId]);
        console.log(
          `[coord-cache] auto-deleted coord ${coordId} (conf=${confidence.toFixed(2)}, samples=${success_count + fail_count})`,
        );
        return null;
      }

      return confidence;
    } catch (err) {
      console.error("[coord-cache] incrementFail error:", (err as Error).message);
      return null;
    }
  }

  /**
   * Invalidate cache entries for old app versions.
   * Call when device reports a new app version.
   */
  async invalidateOldVersions(app: string, currentVersion: string): Promise<number> {
    try {
      const result = await getDb().query(
        `DELETE FROM coordinate_cache WHERE app = $1 AND app_version != $2`,
        [app, currentVersion],
      );
      const deleted = result.rowCount ?? 0;
      if (deleted > 0) {
        console.log(`[coord-cache] invalidated ${deleted} old version entries for ${app}`);
      }
      return deleted;
    } catch (err) {
      console.error("[coord-cache] invalidateOldVersions error:", (err as Error).message);
      return 0;
    }
  }

  /**
   * Delete entries unused for maxAgeDays days.
   */
  async cleanupStale(maxAgeDays = 30): Promise<number> {
    try {
      const result = await getDb().query(
        `DELETE FROM coordinate_cache
         WHERE last_used_at < NOW() - INTERVAL '1 day' * $1
            OR (last_used_at IS NULL AND created_at < NOW() - INTERVAL '1 day' * $1)`,
        [maxAgeDays],
      );
      return result.rowCount ?? 0;
    } catch (err) {
      console.error("[coord-cache] cleanupStale error:", (err as Error).message);
      return 0;
    }
  }

  /** Clear all entries for an app (manual invalidation). */
  async clearApp(app: string): Promise<number> {
    try {
      const result = await getDb().query(
        `DELETE FROM coordinate_cache WHERE app = $1`,
        [app],
      );
      return result.rowCount ?? 0;
    } catch (err) {
      console.error("[coord-cache] clearApp error:", (err as Error).message);
      return 0;
    }
  }

  async getStats(): Promise<{
    total: number;
    byApp: Record<string, number>;
    avgConfidence: number;
  }> {
    const db = getDb();
    const [total, byApp, avg] = await Promise.all([
      db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM coordinate_cache`),
      db.query<{ app: string; count: number }>(
        `SELECT app, COUNT(*)::int AS count FROM coordinate_cache GROUP BY app`,
      ),
      db.query<{ avg: string }>(
        `SELECT COALESCE(AVG(confidence), 0) AS avg FROM coordinate_cache`,
      ),
    ]);
    const apps: Record<string, number> = {};
    for (const row of byApp.rows) apps[row.app] = row.count;
    return {
      total:         total.rows[0]?.count ?? 0,
      byApp:         apps,
      avgConfidence: parseFloat(avg.rows[0]?.avg ?? "0"),
    };
  }
}

export const coordCacheService = new CoordCacheService();

// ─── Backward compat ──────────────────────────────────────────────────────────
// Old code imported `skillDbService` — keep stub to avoid import errors.

export const skillDbService = {
  loadDefinition:             async () => { console.warn("[skill-db] DEPRECATED"); return null; },
  loadCoordsCache:            async () => null,
  saveLearnedCoord:           async () => {},
  syncCoordsToSameResolution: async () => 0,
  getCoord:                   async () => null,
};
