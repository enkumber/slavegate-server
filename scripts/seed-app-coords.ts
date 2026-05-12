#!/usr/bin/env npx ts-node
/**
 * scripts/seed-app-coords.ts
 * Pre-seed coordinate cache for all apps and resolutions.
 * 
 * Usage: 
 *   npx ts-node scripts/seed-app-coords.ts              # seed all
 *   npx ts-node scripts/seed-app-coords.ts instagram    # seed only Instagram
 *   npx ts-node scripts/seed-app-coords.ts tiktok       # seed only TikTok
 * 
 * Safe to re-run — uses ON CONFLICT DO NOTHING.
 * All coordinates are NORMALIZED (0.0-1.0).
 */

import { getDb, closeDb } from "../src/db/client";

// ═══════════════════════════════════════════════════════════════════════════════
// FLEET CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const DEVICE_CLASS = "phone";
const ORIENTATION = "portrait";
const FONT_SCALE = "normal";

// Fleet resolutions (height in pixels, width is always 1080)
const RESOLUTIONS = [
  { res: "1080x1920", height: 1920 }, // OnePlus 5 (16:9)
  { res: "1080x2160", height: 2160 }, // OnePlus 5T (18:9)
  { res: "1080x2340", height: 2340 }, // OnePlus 6T (19.5:9)
];

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface CoordEntry {
  screen: string;
  element: string;
  x: number;
  y: number | "nav_bottom";  // "nav_bottom" = auto-calculate based on nav bar offset
  confidence: number;
}

interface AppConfig {
  package: string;
  version: string;
  navBarOffsetPx: number;  // pixels from bottom to nav bar center
  coords: CoordEntry[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Calculate nav bar Y based on screen height
// ═══════════════════════════════════════════════════════════════════════════════

function calcNavY(screenHeight: number, navBarOffsetPx: number): number {
  // Nav bar center is navBarOffsetPx from bottom
  // Y = (screenHeight - navBarOffsetPx) / screenHeight
  return (screenHeight - navBarOffsetPx) / screenHeight;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSTAGRAM CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const INSTAGRAM: AppConfig = {
  package: "com.instagram.android",
  version: "320.0.0",
  navBarOffsetPx: 189, // measured on OP5T: 2160 - 1971 = 189
  coords: [
    // ─── NAV BAR (bottom, auto-calculated Y) ───────────────────────────────────
    { screen: "any", element: "nav.home",    x: 0.10, y: "nav_bottom", confidence: 1.0 },
    { screen: "any", element: "nav.search",  x: 0.30, y: "nav_bottom", confidence: 1.0 },
    { screen: "any", element: "nav.create",  x: 0.50, y: "nav_bottom", confidence: 1.0 },
    { screen: "any", element: "nav.reels",   x: 0.70, y: "nav_bottom", confidence: 1.0 },
    { screen: "any", element: "nav.profile", x: 0.90, y: "nav_bottom", confidence: 1.0 },
    
    // ─── BACK BUTTON (top left, fixed) ─────────────────────────────────────────
    { screen: "any", element: "nav.back", x: 0.05, y: 0.05, confidence: 0.90 },
    
    // ─── TOP BAR (home feed) ───────────────────────────────────────────────────
    { screen: "home_feed", element: "top.camera",   x: 0.08, y: 0.05, confidence: 0.90 },
    { screen: "home_feed", element: "top.messages", x: 0.92, y: 0.05, confidence: 0.90 },
    { screen: "home_feed", element: "top.activity", x: 0.84, y: 0.05, confidence: 0.85 },
    
    // ─── SEARCH SCREEN ─────────────────────────────────────────────────────────
    { screen: "search_explore", element: "search.input",        x: 0.50, y: 0.06, confidence: 0.90 },
    { screen: "search_explore", element: "search.tab_accounts", x: 0.20, y: 0.12, confidence: 0.85 },
    { screen: "search_explore", element: "search.tab_tags",     x: 0.40, y: 0.12, confidence: 0.85 },
    { screen: "search_explore", element: "search.tab_places",   x: 0.60, y: 0.12, confidence: 0.85 },
    { screen: "search_explore", element: "search.clear",        x: 0.95, y: 0.06, confidence: 0.85 },
    
    // ─── OWN PROFILE ───────────────────────────────────────────────────────────
    { screen: "own_profile", element: "profile.posts_count",     x: 0.36, y: 0.164, confidence: 0.90 },
    { screen: "own_profile", element: "profile.followers_count", x: 0.50, y: 0.164, confidence: 0.90 },
    { screen: "own_profile", element: "profile.following_count", x: 0.64, y: 0.164, confidence: 0.90 },
    { screen: "own_profile", element: "profile.edit",            x: 0.50, y: 0.26,  confidence: 0.90 },
    
    // ─── OTHER PROFILE ─────────────────────────────────────────────────────────
    { screen: "other_profile", element: "profile.posts_count",     x: 0.36, y: 0.145, confidence: 0.85 },
    { screen: "other_profile", element: "profile.followers_count", x: 0.50, y: 0.145, confidence: 0.85 },
    { screen: "other_profile", element: "profile.following_count", x: 0.64, y: 0.145, confidence: 0.85 },
    { screen: "other_profile", element: "profile.follow",          x: 0.30, y: 0.24,  confidence: 0.90 },
    { screen: "other_profile", element: "profile.following",       x: 0.30, y: 0.24,  confidence: 0.90 },
    { screen: "other_profile", element: "profile.message",         x: 0.70, y: 0.24,  confidence: 0.85 },
    
    // ─── FOLLOWERS/FOLLOWING LIST ──────────────────────────────────────────────
    { screen: "followers_list", element: "followers.search", x: 0.50, y: 0.08, confidence: 0.85 },
    { screen: "following_list", element: "followers.search", x: 0.50, y: 0.08, confidence: 0.85 },
    
    // ─── POST DETAIL ───────────────────────────────────────────────────────────
    { screen: "post_detail", element: "post.like",    x: 0.08, y: 0.52, confidence: 0.85 },
    { screen: "post_detail", element: "post.comment", x: 0.16, y: 0.52, confidence: 0.85 },
    { screen: "post_detail", element: "post.share",   x: 0.24, y: 0.52, confidence: 0.85 },
    { screen: "post_detail", element: "post.save",    x: 0.92, y: 0.52, confidence: 0.85 },
    { screen: "post_detail", element: "post.more",    x: 0.95, y: 0.10, confidence: 0.85 },
    
    // ─── COMMENTS ──────────────────────────────────────────────────────────────
    { screen: "comments_full", element: "comment.input",       x: 0.50, y: 0.94, confidence: 0.90 },
    { screen: "comments_full", element: "comment.post_button", x: 0.92, y: 0.94, confidence: 0.90 },
    
    // ─── DIALOGS (centered modals) ─────────────────────────────────────────────
    { screen: "any", element: "dialog.confirm",    x: 0.50, y: 0.55, confidence: 0.90 },
    { screen: "any", element: "dialog.cancel",     x: 0.50, y: 0.62, confidence: 0.90 },
    { screen: "any", element: "dialog.dismiss",    x: 0.50, y: 0.70, confidence: 0.85 },
    { screen: "any", element: "dialog.allow",      x: 0.75, y: 0.55, confidence: 0.85 },
    { screen: "any", element: "dialog.deny",       x: 0.25, y: 0.55, confidence: 0.85 },
    { screen: "any", element: "dialog.close",      x: 0.90, y: 0.25, confidence: 0.85 },
    { screen: "action_blocked", element: "dialog.ok_blocked", x: 0.50, y: 0.58, confidence: 0.95 },
    
    // ─── STORIES ───────────────────────────────────────────────────────────────
    { screen: "stories", element: "stories.next",  x: 0.85, y: 0.50, confidence: 0.85 },
    { screen: "stories", element: "stories.close", x: 0.06, y: 0.05, confidence: 0.85 },
    
    // ─── REELS ─────────────────────────────────────────────────────────────────
    { screen: "reels", element: "post.like",    x: 0.92, y: 0.45, confidence: 0.85 },
    { screen: "reels", element: "post.comment", x: 0.92, y: 0.55, confidence: 0.85 },
    { screen: "reels", element: "post.share",   x: 0.92, y: 0.65, confidence: 0.85 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// TIKTOK CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const TIKTOK: AppConfig = {
  package: "com.zhiliaoapp.musically",
  version: "35.0.0",  // Current version
  navBarOffsetPx: 100, // TikTok has smaller nav bar
  coords: [
    // ─── NAV BAR (bottom) ──────────────────────────────────────────────────────
    { screen: "any", element: "nav.home",     x: 0.10, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.discover", x: 0.30, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.create",   x: 0.50, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.inbox",    x: 0.70, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.profile",  x: 0.90, y: "nav_bottom", confidence: 0.95 },
    
    // ─── BACK BUTTON ───────────────────────────────────────────────────────────
    { screen: "any", element: "nav.back", x: 0.05, y: 0.05, confidence: 0.90 },
    
    // ─── FOR YOU / FOLLOWING TABS ──────────────────────────────────────────────
    { screen: "home", element: "tab.following", x: 0.35, y: 0.06, confidence: 0.90 },
    { screen: "home", element: "tab.for_you",   x: 0.55, y: 0.06, confidence: 0.90 },
    
    // ─── VIDEO ACTIONS (right side) ────────────────────────────────────────────
    { screen: "video", element: "video.like",     x: 0.92, y: 0.40, confidence: 0.85 },
    { screen: "video", element: "video.comment",  x: 0.92, y: 0.50, confidence: 0.85 },
    { screen: "video", element: "video.bookmark", x: 0.92, y: 0.60, confidence: 0.85 },
    { screen: "video", element: "video.share",    x: 0.92, y: 0.70, confidence: 0.85 },
    
    // ─── PROFILE ───────────────────────────────────────────────────────────────
    { screen: "profile", element: "profile.follow",          x: 0.50, y: 0.35, confidence: 0.85 },
    { screen: "profile", element: "profile.followers_count", x: 0.30, y: 0.28, confidence: 0.85 },
    { screen: "profile", element: "profile.following_count", x: 0.50, y: 0.28, confidence: 0.85 },
    { screen: "profile", element: "profile.likes_count",     x: 0.70, y: 0.28, confidence: 0.85 },
    
    // ─── SEARCH ────────────────────────────────────────────────────────────────
    { screen: "discover", element: "search.input", x: 0.50, y: 0.06, confidence: 0.90 },
    
    // ─── DIALOGS ───────────────────────────────────────────────────────────────
    { screen: "any", element: "dialog.confirm", x: 0.50, y: 0.55, confidence: 0.85 },
    { screen: "any", element: "dialog.cancel",  x: 0.50, y: 0.65, confidence: 0.85 },
    { screen: "any", element: "dialog.close",   x: 0.90, y: 0.20, confidence: 0.85 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// PINTEREST CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const PINTEREST: AppConfig = {
  package: "com.pinterest",
  version: "12.0.0",
  navBarOffsetPx: 100,
  coords: [
    // ─── NAV BAR (bottom) ──────────────────────────────────────────────────────
    { screen: "any", element: "nav.home",    x: 0.10, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.search",  x: 0.30, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.create",  x: 0.50, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.inbox",   x: 0.70, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.profile", x: 0.90, y: "nav_bottom", confidence: 0.95 },
    
    // ─── BACK/CLOSE ────────────────────────────────────────────────────────────
    { screen: "any", element: "nav.back",  x: 0.05, y: 0.05, confidence: 0.90 },
    { screen: "any", element: "nav.close", x: 0.05, y: 0.05, confidence: 0.90 },
    
    // ─── SEARCH ────────────────────────────────────────────────────────────────
    { screen: "search", element: "search.input", x: 0.50, y: 0.06, confidence: 0.90 },
    { screen: "search", element: "search.clear", x: 0.95, y: 0.06, confidence: 0.85 },
    
    // ─── PIN ACTIONS ───────────────────────────────────────────────────────────
    { screen: "pin_detail", element: "pin.save",    x: 0.85, y: 0.08, confidence: 0.85 },
    { screen: "pin_detail", element: "pin.like",    x: 0.50, y: 0.92, confidence: 0.85 },
    { screen: "pin_detail", element: "pin.comment", x: 0.70, y: 0.92, confidence: 0.85 },
    { screen: "pin_detail", element: "pin.share",   x: 0.90, y: 0.92, confidence: 0.85 },
    
    // ─── PROFILE ───────────────────────────────────────────────────────────────
    { screen: "profile", element: "profile.follow",     x: 0.50, y: 0.30, confidence: 0.85 },
    { screen: "profile", element: "profile.followers",  x: 0.35, y: 0.22, confidence: 0.85 },
    { screen: "profile", element: "profile.following",  x: 0.65, y: 0.22, confidence: 0.85 },
    { screen: "profile", element: "profile.settings",   x: 0.92, y: 0.05, confidence: 0.85 },
    
    // ─── DIALOGS ───────────────────────────────────────────────────────────────
    { screen: "any", element: "dialog.confirm", x: 0.50, y: 0.55, confidence: 0.85 },
    { screen: "any", element: "dialog.cancel",  x: 0.50, y: 0.65, confidence: 0.85 },
    { screen: "any", element: "dialog.close",   x: 0.90, y: 0.20, confidence: 0.85 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// TWITTER/X CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const TWITTER: AppConfig = {
  package: "com.twitter.android",
  version: "10.0.0",
  navBarOffsetPx: 120,
  coords: [
    // ─── NAV BAR (bottom) ──────────────────────────────────────────────────────
    { screen: "any", element: "nav.home",         x: 0.10, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.search",       x: 0.30, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.communities",  x: 0.50, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.notifications", x: 0.70, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.messages",     x: 0.90, y: "nav_bottom", confidence: 0.95 },
    
    // ─── TOP BAR ───────────────────────────────────────────────────────────────
    { screen: "home", element: "nav.profile",  x: 0.08, y: 0.05, confidence: 0.90 },
    { screen: "any",  element: "nav.back",     x: 0.05, y: 0.05, confidence: 0.90 },
    
    // ─── COMPOSE ───────────────────────────────────────────────────────────────
    { screen: "home", element: "compose.fab", x: 0.90, y: 0.85, confidence: 0.90 },
    
    // ─── TWEET ACTIONS ─────────────────────────────────────────────────────────
    { screen: "tweet", element: "tweet.reply",    x: 0.12, y: 0.95, confidence: 0.85 },
    { screen: "tweet", element: "tweet.retweet",  x: 0.37, y: 0.95, confidence: 0.85 },
    { screen: "tweet", element: "tweet.like",     x: 0.62, y: 0.95, confidence: 0.85 },
    { screen: "tweet", element: "tweet.bookmark", x: 0.87, y: 0.95, confidence: 0.85 },
    { screen: "tweet", element: "tweet.share",    x: 0.95, y: 0.95, confidence: 0.85 },
    
    // ─── PROFILE ───────────────────────────────────────────────────────────────
    { screen: "profile", element: "profile.follow",     x: 0.85, y: 0.18, confidence: 0.85 },
    { screen: "profile", element: "profile.followers",  x: 0.25, y: 0.28, confidence: 0.85 },
    { screen: "profile", element: "profile.following",  x: 0.45, y: 0.28, confidence: 0.85 },
    
    // ─── SEARCH ────────────────────────────────────────────────────────────────
    { screen: "search", element: "search.input", x: 0.50, y: 0.06, confidence: 0.90 },
    
    // ─── DIALOGS ───────────────────────────────────────────────────────────────
    { screen: "any", element: "dialog.confirm", x: 0.50, y: 0.55, confidence: 0.85 },
    { screen: "any", element: "dialog.cancel",  x: 0.50, y: 0.45, confidence: 0.85 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// FACEBOOK CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const FACEBOOK: AppConfig = {
  package: "com.facebook.katana",
  version: "450.0.0",
  navBarOffsetPx: 130,
  coords: [
    // ─── NAV BAR (top on Facebook!) ────────────────────────────────────────────
    // Facebook uses TOP nav bar unlike others
    { screen: "any", element: "nav.feed",          x: 0.10, y: 0.065, confidence: 0.95 },
    { screen: "any", element: "nav.friends",       x: 0.30, y: 0.065, confidence: 0.95 },
    { screen: "any", element: "nav.watch",         x: 0.50, y: 0.065, confidence: 0.95 },
    { screen: "any", element: "nav.marketplace",   x: 0.70, y: 0.065, confidence: 0.95 },
    { screen: "any", element: "nav.notifications", x: 0.90, y: 0.065, confidence: 0.95 },
    
    // ─── TOP RIGHT ─────────────────────────────────────────────────────────────
    { screen: "any", element: "nav.search",   x: 0.85, y: 0.025, confidence: 0.90 },
    { screen: "any", element: "nav.messages", x: 0.95, y: 0.025, confidence: 0.90 },
    { screen: "any", element: "nav.profile",  x: 0.08, y: 0.025, confidence: 0.90 },
    { screen: "any", element: "nav.back",     x: 0.05, y: 0.05,  confidence: 0.90 },
    
    // ─── POST ACTIONS ──────────────────────────────────────────────────────────
    { screen: "post", element: "post.like",    x: 0.17, y: 0.92, confidence: 0.85 },
    { screen: "post", element: "post.comment", x: 0.50, y: 0.92, confidence: 0.85 },
    { screen: "post", element: "post.share",   x: 0.83, y: 0.92, confidence: 0.85 },
    
    // ─── PROFILE ───────────────────────────────────────────────────────────────
    { screen: "profile", element: "profile.add_friend", x: 0.30, y: 0.35, confidence: 0.85 },
    { screen: "profile", element: "profile.message",    x: 0.70, y: 0.35, confidence: 0.85 },
    { screen: "profile", element: "profile.friends",    x: 0.50, y: 0.28, confidence: 0.85 },
    
    // ─── DIALOGS ───────────────────────────────────────────────────────────────
    { screen: "any", element: "dialog.confirm", x: 0.70, y: 0.55, confidence: 0.85 },
    { screen: "any", element: "dialog.cancel",  x: 0.30, y: 0.55, confidence: 0.85 },
    { screen: "any", element: "dialog.close",   x: 0.90, y: 0.20, confidence: 0.85 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// THREADS CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const THREADS: AppConfig = {
  package: "com.instagram.barcelona",
  version: "320.0.0",  // Uses Instagram versioning
  navBarOffsetPx: 189, // Same as Instagram
  coords: [
    // ─── NAV BAR (bottom, same pattern as Instagram) ───────────────────────────
    { screen: "any", element: "nav.home",     x: 0.10, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.search",   x: 0.30, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.create",   x: 0.50, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.activity", x: 0.70, y: "nav_bottom", confidence: 0.95 },
    { screen: "any", element: "nav.profile",  x: 0.90, y: "nav_bottom", confidence: 0.95 },
    
    // ─── BACK ──────────────────────────────────────────────────────────────────
    { screen: "any", element: "nav.back", x: 0.05, y: 0.05, confidence: 0.90 },
    
    // ─── THREAD ACTIONS ────────────────────────────────────────────────────────
    { screen: "thread", element: "thread.like",    x: 0.08, y: 0.95, confidence: 0.85 },
    { screen: "thread", element: "thread.reply",   x: 0.20, y: 0.95, confidence: 0.85 },
    { screen: "thread", element: "thread.repost",  x: 0.32, y: 0.95, confidence: 0.85 },
    { screen: "thread", element: "thread.share",   x: 0.44, y: 0.95, confidence: 0.85 },
    
    // ─── PROFILE ───────────────────────────────────────────────────────────────
    { screen: "profile", element: "profile.follow",    x: 0.50, y: 0.28, confidence: 0.85 },
    { screen: "profile", element: "profile.followers", x: 0.35, y: 0.22, confidence: 0.85 },
    
    // ─── SEARCH ────────────────────────────────────────────────────────────────
    { screen: "search", element: "search.input", x: 0.50, y: 0.06, confidence: 0.90 },
    
    // ─── DIALOGS ───────────────────────────────────────────────────────────────
    { screen: "any", element: "dialog.confirm", x: 0.50, y: 0.55, confidence: 0.85 },
    { screen: "any", element: "dialog.cancel",  x: 0.50, y: 0.65, confidence: 0.85 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// ALL APPS
// ═══════════════════════════════════════════════════════════════════════════════

const ALL_APPS: Record<string, AppConfig> = {
  instagram: INSTAGRAM,
  tiktok: TIKTOK,
  pinterest: PINTEREST,
  twitter: TWITTER,
  facebook: FACEBOOK,
  threads: THREADS,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SEED FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

async function seedApp(db: ReturnType<typeof getDb>, app: AppConfig): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  
  for (const resolution of RESOLUTIONS) {
    for (const coord of app.coords) {
      // Calculate Y for nav_bottom elements
      const y = coord.y === "nav_bottom" 
        ? calcNavY(resolution.height, app.navBarOffsetPx)
        : coord.y;
      
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
          app.package, app.version, resolution.res, DEVICE_CLASS, ORIENTATION, FONT_SCALE,
          coord.screen, coord.element, coord.x, y, coord.confidence, "manual"
        ]);
        
        if (result.rowCount && result.rowCount > 0) {
          inserted++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`  ✗ ${resolution.res}:${coord.screen}:${coord.element}: ${(err as Error).message}`);
      }
    }
  }
  
  return { inserted, skipped };
}

async function main(): Promise<void> {
  const db = getDb();
  const targetApp = process.argv[2]?.toLowerCase();
  
  const appsToSeed = targetApp 
    ? { [targetApp]: ALL_APPS[targetApp] }
    : ALL_APPS;
  
  if (targetApp && !ALL_APPS[targetApp]) {
    console.error(`[seed] Unknown app: ${targetApp}`);
    console.error(`[seed] Available: ${Object.keys(ALL_APPS).join(", ")}`);
    process.exit(1);
  }
  
  console.log(`[seed] Seeding coordinates for: ${Object.keys(appsToSeed).join(", ")}`);
  console.log(`[seed] Resolutions: ${RESOLUTIONS.map(r => r.res).join(", ")}`);
  console.log("");
  
  let totalInserted = 0;
  let totalSkipped = 0;
  
  for (const [name, app] of Object.entries(appsToSeed)) {
    if (!app) continue;
    
    const coordCount = app.coords.length * RESOLUTIONS.length;
    console.log(`[seed] ${name}: ${app.package} v${app.version}`);
    console.log(`[seed]   ${app.coords.length} elements × ${RESOLUTIONS.length} resolutions = ${coordCount} entries`);
    
    const { inserted, skipped } = await seedApp(db, app);
    totalInserted += inserted;
    totalSkipped += skipped;
    
    console.log(`[seed]   ✓ ${inserted} inserted, ${skipped} already exist`);
    console.log("");
  }
  
  console.log(`[seed] Total: ${totalInserted} inserted, ${totalSkipped} already exist`);
  
  // Show stats
  const stats = await db.query(`
    SELECT app, COUNT(*)::int as count, COUNT(DISTINCT resolution)::int as resolutions
    FROM coordinate_cache 
    WHERE learn_method = 'manual'
    GROUP BY app
    ORDER BY app
  `);
  
  console.log("\n[seed] DB summary (manual seeds):");
  for (const row of stats.rows) {
    console.log(`  ${row.app}: ${row.count} coords across ${row.resolutions} resolutions`);
  }
  
  await closeDb();
}

main().catch((err) => {
  console.error("[seed] Fatal:", err.message);
  process.exit(1);
});
