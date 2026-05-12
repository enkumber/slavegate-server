/**
 * data-pipeline/parsers/instagram/parser.ts
 * Instagram parser — implements PlatformParser for com.instagram.android.
 *
 * Primary: UI tree (AccessibilityService) — fast, zero cost.
 * Fallback: VLM output (when UI tree doesn't have accessibility metadata).
 *
 * App version pinning: update `compatibleAppVersions` when testing new IG versions.
 * Canary device monitors extraction rate — if < 50%, triggers parser update alert.
 */

import type { PlatformParser, UiNode, VlmResult, ExtractedContent, KnownElement, ScreenType } from "../../parser-interface";
import * as elements from "./elements";
import crypto from "crypto";

export class InstagramParser implements PlatformParser {
  readonly platform = "instagram";
  readonly version  = "1.1.0";
  readonly compatibleAppVersions = ["300+", "301+", "302+", "303+"];

  isCompatible(appVersion: string): boolean {
    // "300+" means >= 300; exact versions match exactly
    return this.compatibleAppVersions.some(v => {
      if (v.endsWith("+")) {
        const min = parseInt(v.slice(0, -1), 10);
        const cur = parseInt(appVersion.split(".")[0], 10);
        return !isNaN(min) && !isNaN(cur) && cur >= min;
      }
      return appVersion.startsWith(v);
    });
  }

  detectScreen(uiTree: UiNode[]): ScreenType {
    const allText = collectText(uiTree).join(" ").toLowerCase();
    const allIds  = collectResourceIds(uiTree).join(" ");

    if (allIds.includes("feed_tab") || allIds.includes("action_bar_title"))    return "feed";
    if (allIds.includes("profile_header") || allIds.includes("follow_button")) return "profile";
    if (allIds.includes("comment_list_view") || allIds.includes("like_button_container")) return "post_detail";
    if (allIds.includes("reel_viewer") || allIds.includes("clips_viewer"))      return "reels";
    if (allIds.includes("story_viewer") || allIds.includes("story_progress"))   return "story";
    if (allIds.includes("search_box") || allText.includes("search"))            return "search";
    if (allIds.includes("activity_list") || allText.includes("notifications"))  return "notifications";
    if (allIds.includes("direct_thread") || allText.includes("message"))        return "messages";
    return "unknown";
  }

  parseUiTree(uiTree: UiNode[]): ExtractedContent[] {
    const screen = this.detectScreen(uiTree);
    const results: ExtractedContent[] = [];

    if (screen === "feed" || screen === "post_detail") {
      const posts = extractPosts(uiTree, screen);
      results.push(...posts);
    }
    if (screen === "profile") {
      const profile = extractProfile(uiTree);
      if (profile) results.push(profile);
    }
    if (screen === "reels") {
      const reel = extractReel(uiTree);
      if (reel) results.push(reel);
    }

    return results;
  }

  parseVlmOutput(vlmResult: VlmResult): ExtractedContent[] {
    // Extract from VLM scene description and elements when UI tree fails
    const results: ExtractedContent[] = [];
    const desc = vlmResult.sceneDescription ?? "";

    // Extract any visible numeric engagement data from VLM text
    const likes    = extractNumber(desc, /(\d[\d.,k]+)\s*likes?/i);
    const comments = extractNumber(desc, /(\d[\d.,k]+)\s*comments?/i);

    if (likes !== null || comments !== null) {
      results.push({
        platform:     "instagram",
        contentType:  "post",
        contentHash:  crypto.createHash("sha256").update(`vlm:${desc.slice(0, 100)}`).digest("hex"),
        author:       extractAuthor(desc),
        textContent:  vlmResult.sceneDescription,
        engagement:   {
          likes:    likes ?? undefined,
          comments: comments ?? undefined,
        },
        mediaUrls:    [],
        confidence:   0.5,  // Lower confidence for VLM-extracted data
        parserVersion: `${this.version}-vlm`,
      });
    }

    return results;
  }

  getKnownElements(appVersion: string): KnownElement[] {
    return elements.getKnownElements(appVersion);
  }
}

// ─── Post extraction ──────────────────────────────────────────────────────────

function extractPosts(uiTree: UiNode[], screen: ScreenType): ExtractedContent[] {
  const results: ExtractedContent[] = [];
  const postNodes = findByResourceIdPattern(uiTree, /row_feed_photo|media_block|carousel_media/);

  for (const node of postNodes.slice(0, 10)) { // Max 10 posts per screen
    const author  = findTextByResourceId(node, /username|author_name/) ?? "";
    const caption = findTextByResourceId(node, /caption_text|media_caption/) ?? null;
    const likeStr = findTextByResourceId(node, /like_count|likes_count/) ?? "";
    const comStr  = findTextByResourceId(node, /comment_count/) ?? "";

    if (!author) continue;

    const content: ExtractedContent = {
      platform:     "instagram",
      contentType:  screen === "post_detail" ? "post" : "post",
      contentHash:  crypto.createHash("sha256")
        .update(`instagram:${author}:${caption?.slice(0, 50) ?? ""}`)
        .digest("hex"),
      author,
      textContent:  caption,
      engagement:   {
        likes:    parseCount(likeStr),
        comments: parseCount(comStr),
      },
      mediaUrls:    [],
      confidence:   0.9,
      parserVersion: new InstagramParser().version,
    };
    results.push(content);
  }
  return results;
}

function extractProfile(uiTree: UiNode[]): ExtractedContent | null {
  const username   = findTextByResourceId(uiTree, /action_bar_title|profile_username/) ?? "";
  const followers  = findTextByResourceId(uiTree, /followers_count/) ?? "";
  const following  = findTextByResourceId(uiTree, /following_count/) ?? "";
  const posts      = findTextByResourceId(uiTree, /posts_count/) ?? "";
  const bio        = findTextByResourceId(uiTree, /profile_bio|biography/) ?? null;

  if (!username) return null;

  return {
    platform:    "instagram",
    contentType: "profile",
    contentHash: crypto.createHash("sha256").update(`instagram:profile:${username}`).digest("hex"),
    author:      username,
    textContent: bio,
    engagement:  {
      likes:    parseCount(followers),    // followers as "likes" proxy for profiles
      comments: parseCount(following),
      views:    parseCount(posts),
    },
    mediaUrls:    [],
    confidence:   0.85,
    parserVersion: new InstagramParser().version,
  };
}

function extractReel(uiTree: UiNode[]): ExtractedContent | null {
  const author = findTextByResourceId(uiTree, /author_username|reel_creator/) ?? "";
  const views  = findTextByResourceId(uiTree, /view_count|play_count/) ?? "";
  const likes  = findTextByResourceId(uiTree, /like_count/) ?? "";

  if (!author) return null;
  return {
    platform:    "instagram",
    contentType: "reel",
    contentHash: crypto.createHash("sha256").update(`instagram:reel:${author}:${views}`).digest("hex"),
    author,
    textContent: null,
    engagement:  { views: parseCount(views), likes: parseCount(likes) },
    mediaUrls:   [],
    confidence:  0.8,
    parserVersion: new InstagramParser().version,
  };
}

// ─── UI tree helpers ─────────────────────────────────────────────────────────

function collectText(nodes: UiNode[]): string[] {
  const texts: string[] = [];
  for (const n of nodes) {
    if (n.text) texts.push(n.text);
    if (n.children) texts.push(...collectText(n.children));
  }
  return texts;
}

function collectResourceIds(nodes: UiNode[]): string[] {
  const ids: string[] = [];
  for (const n of nodes) {
    if (n.resourceId) ids.push(n.resourceId);
    if (n.children) ids.push(...collectResourceIds(n.children));
  }
  return ids;
}

function findByResourceIdPattern(nodes: UiNode[], pattern: RegExp): UiNode[] {
  const found: UiNode[] = [];
  for (const n of nodes) {
    if (n.resourceId && pattern.test(n.resourceId)) found.push(n);
    if (n.children) found.push(...findByResourceIdPattern(n.children, pattern));
  }
  return found;
}

function findTextByResourceId(node: UiNode | UiNode[], pattern: RegExp): string | null {
  const nodes = Array.isArray(node) ? node : [node];
  for (const n of nodes) {
    if (n.resourceId && pattern.test(n.resourceId) && n.text) return n.text;
    if (n.children) {
      const found = findTextByResourceId(n.children, pattern);
      if (found) return found;
    }
  }
  return null;
}

function parseCount(raw: string): number | undefined {
  if (!raw) return undefined;
  const clean = raw.replace(/,/g, "").trim().toLowerCase();
  if (clean.endsWith("k")) return Math.round(parseFloat(clean) * 1_000);
  if (clean.endsWith("m")) return Math.round(parseFloat(clean) * 1_000_000);
  const n = parseInt(clean, 10);
  return isNaN(n) ? undefined : n;
}

function extractNumber(text: string, pattern: RegExp): number | null {
  const m = text.match(pattern);
  if (!m) return null;
  return parseCount(m[1]) ?? null;
}

function extractAuthor(text: string): string {
  const m = text.match(/by\s+@?(\w+)/i) ?? text.match(/@(\w+)/);
  return m?.[1] ?? "unknown";
}
