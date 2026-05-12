/**
 * data-pipeline/parsers/tiktok/parser.ts
 * TikTok parser — com.zhiliaoapp.musically
 *
 * TikTok UI is mostly canvas-rendered (React Native + custom renderer).
 * AccessibilityService gets limited metadata — resource IDs are obfuscated
 * and change per version. Strategy: text + content-description + class patterns.
 *
 * Primary: UI tree (low yield ~60% vs Instagram ~85%) → VLM fallback more common.
 * Fallback: VLM output via parseVlmOutput().
 */

import type { PlatformParser, UiNode, VlmResult, ExtractedContent, KnownElement, ScreenType } from "../../parser-interface";
import * as elements from "./elements";
import crypto from "crypto";

export class TikTokParser implements PlatformParser {
  readonly platform = "tiktok";
  readonly version  = "1.0.0";
  readonly compatibleAppVersions = ["30+"];

  isCompatible(appVersion: string): boolean {
    const major = parseInt(appVersion.split(".")[0], 10);
    return !isNaN(major) && major >= 30;
  }

  detectScreen(uiTree: UiNode[]): ScreenType {
    const ids  = collectResourceIds(uiTree).join(" ");
    const text = collectText(uiTree).join(" ").toLowerCase();

    if (ids.includes("home_tab") || text.includes("for you"))     return "feed";
    if (ids.includes("follow_btn") || text.includes("followers")) return "profile";
    if (text.includes("comments") || ids.includes("comment"))     return "post_detail";
    if (ids.includes("video_player") || text.includes("views"))   return "reels";
    if (text.includes("search"))                                   return "search";
    if (text.includes("notifications") || text.includes("activity")) return "notifications";
    return "unknown";
  }

  parseUiTree(uiTree: UiNode[]): ExtractedContent[] {
    const screen  = this.detectScreen(uiTree);
    const results: ExtractedContent[] = [];

    if (screen === "feed" || screen === "reels") {
      const videos = extractVideos(uiTree, this.version);
      results.push(...videos);
    }
    if (screen === "profile") {
      const profile = extractProfile(uiTree, this.version);
      if (profile) results.push(profile);
    }
    return results;
  }

  parseVlmOutput(vlmResult: VlmResult): ExtractedContent[] {
    const desc = vlmResult.sceneDescription ?? "";
    const results: ExtractedContent[] = [];

    const likes   = extractNumber(desc, /(\d[\d.,k]+)\s*likes?/i);
    const views   = extractNumber(desc, /(\d[\d.,k]+)\s*views?/i);
    const author  = extractAuthor(desc);

    if (views !== null || likes !== null) {
      results.push({
        platform:     "tiktok",
        contentType:  "reel",
        contentHash:  crypto.createHash("sha256")
          .update(`tiktok:vlm:${author}:${desc.slice(0, 80)}`)
          .digest("hex"),
        author,
        textContent:  desc,
        engagement:   { likes: likes ?? undefined, views: views ?? undefined },
        mediaUrls:    [],
        confidence:   0.45,
        parserVersion: `${this.version}-vlm`,
      });
    }
    return results;
  }

  getKnownElements(appVersion: string): KnownElement[] {
    return elements.getKnownElements(appVersion);
  }
}

// ─── Video extraction ─────────────────────────────────────────────────────────

function extractVideos(uiTree: UiNode[], parserVersion: string): ExtractedContent[] {
  const results: ExtractedContent[] = [];

  // TikTok shows one video at a time — look for author + engagement data
  const author   = findText(uiTree, /@[\w.]+/) ?? findTextByPattern(uiTree, /^@/) ?? "";
  const desc     = findTextByPattern(uiTree, /^[^@#\d].*[a-z]{3,}/) ?? null;
  const likeStr  = findTextNear(uiTree, "like")  ?? "";
  const viewStr  = findTextNear(uiTree, "view")  ?? "";
  const shareStr = findTextNear(uiTree, "share") ?? "";

  if (!author) return results;

  results.push({
    platform:    "tiktok",
    contentType: "reel",
    contentHash: crypto.createHash("sha256")
      .update(`tiktok:${author}:${desc?.slice(0, 50) ?? ""}`)
      .digest("hex"),
    author:      author.replace(/^@/, ""),
    textContent: desc,
    engagement:  {
      likes:   parseCount(likeStr),
      views:   parseCount(viewStr),
      shares:  parseCount(shareStr),
    },
    mediaUrls:    [],
    confidence:   0.65,  // Lower than Instagram — TikTok a11y is less reliable
    parserVersion,
  });

  return results;
}

function extractProfile(uiTree: UiNode[], parserVersion: string): ExtractedContent | null {
  const username  = findText(uiTree, /@[\w.]+/) ?? "";
  const followers = findTextNear(uiTree, "followers") ?? "";
  const following = findTextNear(uiTree, "following") ?? "";
  const likes     = findTextNear(uiTree, "likes") ?? "";

  if (!username) return null;

  return {
    platform:    "tiktok",
    contentType: "profile",
    contentHash: crypto.createHash("sha256")
      .update(`tiktok:profile:${username}`)
      .digest("hex"),
    author:      username.replace(/^@/, ""),
    textContent: null,
    engagement:  {
      likes:    parseCount(likes),
      views:    parseCount(followers),
      comments: parseCount(following),
    },
    mediaUrls:   [],
    confidence:  0.7,
    parserVersion,
  };
}

// ─── UI tree helpers ──────────────────────────────────────────────────────────

function collectText(nodes: UiNode[]): string[] {
  const texts: string[] = [];
  const visit = (n: UiNode) => {
    if (n.text) texts.push(n.text);
    n.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return texts;
}

function collectResourceIds(nodes: UiNode[]): string[] {
  const ids: string[] = [];
  const visit = (n: UiNode) => {
    if (n.resourceId) ids.push(n.resourceId);
    n.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return ids;
}

function findText(nodes: UiNode[], pattern: RegExp): string | null {
  const visit = (n: UiNode): string | null => {
    if (n.text && pattern.test(n.text)) return n.text;
    for (const c of (n.children ?? [])) {
      const found = visit(c);
      if (found) return found;
    }
    return null;
  };
  for (const n of nodes) {
    const found = visit(n);
    if (found) return found;
  }
  return null;
}

function findTextByPattern(nodes: UiNode[], pattern: RegExp): string | null {
  return findText(nodes, pattern);
}

function findTextNear(nodes: UiNode[], keyword: string): string | null {
  const allTexts = collectText(nodes);
  const idx = allTexts.findIndex(t => t.toLowerCase().includes(keyword.toLowerCase()));
  if (idx === -1) return null;  // keyword not found — don't scan unrelated nodes
  for (const delta of [-1, 1, -2, 2]) {
    const candidate = allTexts[idx + delta];
    if (candidate && /\d/.test(candidate)) return candidate;
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
  const m = text.match(/@([\w.]+)/) ?? text.match(/by\s+([\w.]+)/i);
  return m?.[1] ?? "unknown";
}
