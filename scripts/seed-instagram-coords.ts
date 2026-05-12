#!/usr/bin/env npx ts-node
/**
 * scripts/seed-instagram-coords.ts
 * Pre-seed coordinate cache with Instagram static elements.
 * 
 * Usage: npx ts-node scripts/seed-instagram-coords.ts
 * 
 * Safe to re-run — uses ON CONFLICT DO NOTHING.
 * All coordinates are NORMALIZED (0.0-1.0).
 */

import { getDb, closeDb } from "../src/db/client";

// ─── Config ───────────────────────────────────────────────────────────────────

const APP = "com.instagram.android";
const APP_VERSION = "320.0.0";  // Current fleet version
const RESOLUTION = "1080x2160"; // OnePlus 5/5T/6T fleet
const DEVICE_CLASS = "phone";
const ORIENTATION = "portrait";
const FONT_SCALE = "normal";

// ─── Static Element Coordinates ───────────────────────────────────────────────
// Derived from instagram.skill learned_coords + manual measurements on OP5T

interface CoordEntry {
  screen: string;     // screen_type_key: 'any' for always-visible, else specific screen
  element: string;    // element_name: 'nav.home', 'profile.follow', etc.
  x: number;          // normalized X (0.0-1.0)
  y: number;          // normalized Y (0.0-1.0)
  confidence: number; // 1.0 for stable elements, lower for variable
}

const STATIC_COORDS: CoordEntry[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // NAV BAR — Bottom, visible on most screens (confidence: 1.0)
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "any", element: "nav.home",     x: 0.10, y: 0.9125, confidence: 1.0 },
  { screen: "any", element: "nav.search",   x: 0.30, y: 0.9125, confidence: 1.0 },
  { screen: "any", element: "nav.create",   x: 0.50, y: 0.9125, confidence: 1.0 },
  { screen: "any", element: "nav.reels",    x: 0.70, y: 0.9125, confidence: 1.0 },
  { screen: "any", element: "nav.profile",  x: 0.90, y: 0.9125, confidence: 1.0 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // BACK BUTTON — Top left, most screens (confidence: 0.90)
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "any", element: "nav.back", x: 0.05, y: 0.05, confidence: 0.90 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TOP BAR — Home feed (confidence: 0.90)
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "home_feed", element: "top.camera",   x: 0.08, y: 0.05, confidence: 0.90 },
  { screen: "home_feed", element: "top.messages", x: 0.92, y: 0.05, confidence: 0.90 },
  { screen: "home_feed", element: "top.activity", x: 0.84, y: 0.05, confidence: 0.85 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH SCREEN (confidence: 0.85-0.90)
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "search_explore", element: "search.input",        x: 0.50, y: 0.06, confidence: 0.90 },
  { screen: "search_explore", element: "search.tab_accounts", x: 0.20, y: 0.12, confidence: 0.85 },
  { screen: "search_explore", element: "search.tab_tags",     x: 0.40, y: 0.12, confidence: 0.85 },
  { screen: "search_explore", element: "search.tab_places",   x: 0.60, y: 0.12, confidence: 0.85 },
  { screen: "search_explore", element: "search.clear",        x: 0.95, y: 0.06, confidence: 0.85 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // OWN PROFILE SCREEN (confidence: 0.90-0.95)
  // ═══════════════════════════════════════════════════════════════════════════
  // Profile stats row — Posts | Followers | Following (y ≈ 0.16-0.18 on modern Instagram)
  { screen: "own_profile", element: "profile.posts_count",     x: 0.36, y: 0.164, confidence: 0.90 },
  { screen: "own_profile", element: "profile.followers_count", x: 0.50, y: 0.164, confidence: 0.90 },
  { screen: "own_profile", element: "profile.following_count", x: 0.64, y: 0.164, confidence: 0.90 },
  { screen: "own_profile", element: "profile.edit",            x: 0.50, y: 0.26,  confidence: 0.90 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // OTHER PROFILE SCREEN (confidence: 0.85-0.95)
  // ═══════════════════════════════════════════════════════════════════════════
  // Stats row position slightly different when viewing other's profile
  { screen: "other_profile", element: "profile.posts_count",     x: 0.36, y: 0.145, confidence: 0.85 },
  { screen: "other_profile", element: "profile.followers_count", x: 0.50, y: 0.145, confidence: 0.85 },
  { screen: "other_profile", element: "profile.following_count", x: 0.64, y: 0.145, confidence: 0.85 },
  // Follow/Following/Message buttons (y ≈ 0.24)
  { screen: "other_profile", element: "profile.follow",     x: 0.30, y: 0.24, confidence: 0.90 },
  { screen: "other_profile", element: "profile.following",  x: 0.30, y: 0.24, confidence: 0.90 },
  { screen: "other_profile", element: "profile.message",    x: 0.70, y: 0.24, confidence: 0.85 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FOLLOWERS / FOLLOWING LIST (confidence: 0.85)
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "followers_list", element: "followers.search", x: 0.50, y: 0.08, confidence: 0.85 },
  { screen: "following_list", element: "followers.search", x: 0.50, y: 0.08, confidence: 0.85 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // POST DETAIL / FEED ACTIONS (confidence: 0.85)
  // These positions are relative within the visible post, ~y=0.52 for mid-screen post
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "post_detail", element: "post.like",    x: 0.08, y: 0.52, confidence: 0.85 },
  { screen: "post_detail", element: "post.comment", x: 0.16, y: 0.52, confidence: 0.85 },
  { screen: "post_detail", element: "post.share",   x: 0.24, y: 0.52, confidence: 0.85 },
  { screen: "post_detail", element: "post.save",    x: 0.92, y: 0.52, confidence: 0.85 },
  { screen: "post_detail", element: "post.more",    x: 0.95, y: 0.10, confidence: 0.85 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // COMMENT INPUT (confidence: 0.90)
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "comments_full", element: "comment.input",       x: 0.50, y: 0.94, confidence: 0.90 },
  { screen: "comments_full", element: "comment.post_button", x: 0.92, y: 0.94, confidence: 0.90 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // DIALOGS — Centered modals (confidence: 0.90-0.95)
  // ═══════════════════════════════════════════════════════════════════════════
  // Unfollow confirmation dialog
  { screen: "any", element: "dialog.confirm",  x: 0.50, y: 0.55, confidence: 0.90 },
  { screen: "any", element: "dialog.cancel",   x: 0.50, y: 0.62, confidence: 0.90 },
  { screen: "any", element: "dialog.dismiss",  x: 0.50, y: 0.70, confidence: 0.85 },
  // Permission dialogs (top-right area typically)
  { screen: "any", element: "dialog.allow",    x: 0.75, y: 0.55, confidence: 0.85 },
  { screen: "any", element: "dialog.deny",     x: 0.25, y: 0.55, confidence: 0.85 },
  // Close/X button (top-right of modal)
  { screen: "any", element: "dialog.close",    x: 0.90, y: 0.25, confidence: 0.85 },
  // Rate limit / blocked action OK button
  { screen: "action_blocked", element: "dialog.ok_blocked", x: 0.50, y: 0.58, confidence: 0.95 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STORIES (confidence: 0.85)
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "stories", element: "stories.next",  x: 0.85, y: 0.50, confidence: 0.85 },
  { screen: "stories", element: "stories.close", x: 0.06, y: 0.05, confidence: 0.85 },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // REELS (confidence: 0.85)
  // ═══════════════════════════════════════════════════════════════════════════
  { screen: "reels", element: "post.like",    x: 0.92, y: 0.45, confidence: 0.85 },
  { screen: "reels", element: "post.comment", x: 0.92, y: 0.55, confidence: 0.85 },
  { screen: "reels", element: "post.share",   x: 0.92, y: 0.65, confidence: 0.85 },
];

// ─── Seed Function ────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  const db = getDb();
  
  console.log(`[seed] Seeding ${STATIC_COORDS.length} Instagram coordinates...`);
  console.log(`[seed] App: ${APP} v${APP_VERSION}, Resolution: ${RESOLUTION}`);
  
  let inserted = 0;
  let skipped = 0;
  
  for (const coord of STATIC_COORDS) {
    try {
      const result = await db.query(`
        INSERT INTO coordinate_cache 
          (app, app_version, resolution, device_class, orientation, font_scale_bucket,
           screen_type_key, element_name, x, y, confidence, learn_method,
           success_count, last_used_at, last_success_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, NOW(), NOW())
        ON CONFLICT (app, app_version, resolution, device_class, orientation, 
                     font_scale_bucket, screen_type_key, element_name)
        DO NOTHING
        RETURNING id
      `, [
        APP, APP_VERSION, RESOLUTION, DEVICE_CLASS, ORIENTATION, FONT_SCALE,
        coord.screen, coord.element, coord.x, coord.y, coord.confidence, "manual"
      ]);
      
      if (result.rowCount && result.rowCount > 0) {
        inserted++;
        console.log(`  ✓ ${coord.screen}:${coord.element} (${coord.x}, ${coord.y})`);
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  ✗ ${coord.screen}:${coord.element}: ${(err as Error).message}`);
    }
  }
  
  console.log(`\n[seed] Complete: ${inserted} inserted, ${skipped} already exist`);
  
  // Show stats
  const stats = await db.query(`
    SELECT COUNT(*)::int as total, 
           COUNT(DISTINCT screen_type_key)::int as screens,
           COUNT(DISTINCT element_name)::int as elements
    FROM coordinate_cache 
    WHERE app = $1 AND app_version = $2
  `, [APP, APP_VERSION]);
  
  const row = stats.rows[0];
  console.log(`[seed] DB now has: ${row.total} coords, ${row.screens} screens, ${row.elements} unique elements for Instagram v${APP_VERSION}`);
  
  await closeDb();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

seed().catch((err) => {
  console.error("[seed] Fatal:", err.message);
  process.exit(1);
});
