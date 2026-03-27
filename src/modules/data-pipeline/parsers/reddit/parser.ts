/**
 * data-pipeline/parsers/reddit/parser.ts
 * Reddit parser — com.reddit.frontpage
 *
 * Reddit's new app has reasonable accessibility support.
 * Key data: subreddit, author (u/username), post title, vote score.
 * Awards + flair extracted as text nodes.
 */

import type { PlatformParser, UiNode, VlmResult, ExtractedContent, KnownElement, ScreenType } from "../../parser-interface";
import * as elements from "./elements";
import crypto from "crypto";

export class RedditParser implements PlatformParser {
  readonly platform = "reddit";
  readonly version  = "1.0.0";
  readonly compatibleAppVersions = ["2024+"];

  isCompatible(appVersion: string): boolean {
    const year = parseInt(appVersion.split(".")[0], 10);
    return !isNaN(year) && year >= 2024;
  }

  detectScreen(uiTree: UiNode[]): ScreenType {
    const ids  = collectResourceIds(uiTree).join(" ");
    const text = collectText(uiTree).join(" ").toLowerCase();

    if (text.includes("r/") && (ids.includes("feed") || text.includes("hot") || text.includes("new"))) return "feed";
    if (text.includes("u/") && (ids.includes("profile") || text.includes("karma")))  return "profile";
    if (ids.includes("comment_list") || text.includes("comments"))                   return "post_detail";
    if (text.includes("search"))                                                      return "search";
    if (text.includes("notifications") || text.includes("inbox"))                    return "notifications";
    return "unknown";
  }

  parseUiTree(uiTree: UiNode[]): ExtractedContent[] {
    const screen  = this.detectScreen(uiTree);
    const results: ExtractedContent[] = [];

    if (screen === "feed") {
      results.push(...extractFeedPosts(uiTree, this.version));
    }
    if (screen === "post_detail") {
      const post = extractDetailPost(uiTree, this.version);
      if (post) results.push(post);
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

    const score     = extractNumber(desc, /(\d[\d.,k]+)\s*(?:points?|votes?|upvotes?)/i);
    const comments  = extractNumber(desc, /(\d[\d.,k]+)\s*comments?/i);
    const subreddit = desc.match(/r\/([\w_]+)/)?.[1] ?? "unknown";
    const author    = desc.match(/u\/([\w_-]+)/)?.[1] ?? "unknown";

    if (score !== null || comments !== null) {
      results.push({
        platform:    "reddit",
        contentType: "post",
        contentHash: crypto.createHash("sha256")
          .update(`reddit:vlm:${subreddit}:${author}:${desc.slice(0, 80)}`)
          .digest("hex"),
        author,
        textContent: desc,
        engagement:  { likes: score ?? undefined, comments: comments ?? undefined },
        mediaUrls:   [],
        confidence:  0.45,
        parserVersion: `${this.version}-vlm`,
      });
    }
    return results;
  }

  getKnownElements(appVersion: string): KnownElement[] {
    return elements.getKnownElements(appVersion);
  }
}

// ─── Feed post extraction ─────────────────────────────────────────────────────

function extractFeedPosts(uiTree: UiNode[], parserVersion: string): ExtractedContent[] {
  const results: ExtractedContent[] = [];
  // Reddit feed: each post card typically has title, subreddit, score, comments
  const postNodes = findByResourceIdPattern(uiTree, /post_card|feed_item|post_list_item/);

  // If no explicit containers found, try to parse the flat tree
  const items = postNodes.length > 0 ? postNodes : [{ children: uiTree } as UiNode];

  for (const node of items.slice(0, 15)) {
    const title      = findTextByPattern(node, /^[A-Z].{10,}/)     ?? "";
    const subreddit  = findText(node, /^r\/[\w_]+/)?.replace(/^r\//, "") ?? "";
    const author     = findText(node, /^u\/[\w_-]+/)?.replace(/^u\//, "") ?? "";
    const scoreStr   = findTextByResourceId(node, /vote_count|score/) ?? findTextNear([node], "upvote") ?? "";
    const commentStr = findTextByResourceId(node, /comment_count/)     ?? findTextNear([node], "comment") ?? "";

    if (!title) continue;

    results.push({
      platform:    "reddit",
      contentType: "post",
      contentHash: crypto.createHash("sha256")
        .update(`reddit:${subreddit}:${author}:${title.slice(0, 60)}`)
        .digest("hex"),
      author:      author || "unknown",
      textContent: title,
      engagement:  {
        likes:    parseCount(scoreStr),
        comments: parseCount(commentStr),
      },
      mediaUrls:   [],
      confidence:  0.8,
      parserVersion,
    });
  }
  return results;
}

function extractDetailPost(uiTree: UiNode[], parserVersion: string): ExtractedContent | null {
  const title      = findTextByPattern(uiTree, /^[A-Z].{15,}/) ?? "";
  const subreddit  = findText(uiTree, /^r\/[\w_]+/)?.replace(/^r\//, "") ?? "";
  const author     = findText(uiTree, /^u\/[\w_-]+/)?.replace(/^u\//, "") ?? "unknown";
  const scoreStr   = findTextByResourceId(uiTree, /vote_count|score/) ?? "";
  const commentStr = findTextByResourceId(uiTree, /comment_count/)    ?? "";
  const body       = findTextByPattern(uiTree, /^[a-z].{20,}/)        ?? null;

  if (!title) return null;

  return {
    platform:    "reddit",
    contentType: "post",
    contentHash: crypto.createHash("sha256")
      .update(`reddit:${subreddit}:${author}:${title.slice(0, 60)}`)
      .digest("hex"),
    author,
    textContent: [title, body].filter(Boolean).join("\n\n"),
    engagement:  {
      likes:    parseCount(scoreStr),
      comments: parseCount(commentStr),
    },
    mediaUrls:   [],
    confidence:  0.85,
    parserVersion,
  };
}

function extractProfile(uiTree: UiNode[], parserVersion: string): ExtractedContent | null {
  const username  = findText(uiTree, /^u\/[\w_-]+/)?.replace(/^u\//, "") ?? "";
  const karmaStr  = findTextNear(uiTree, "karma") ?? "";

  if (!username) return null;

  return {
    platform:    "reddit",
    contentType: "profile",
    contentHash: crypto.createHash("sha256")
      .update(`reddit:profile:${username}`)
      .digest("hex"),
    author:      username,
    textContent: null,
    engagement:  { likes: parseCount(karmaStr) },
    mediaUrls:   [],
    confidence:  0.75,
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

function findText(nodes: UiNode | UiNode[], pattern: RegExp): string | null {
  const arr = Array.isArray(nodes) ? nodes : [nodes];
  for (const n of arr) {
    if (n.text && pattern.test(n.text)) return n.text;
    const found = findText(n.children ?? [], pattern);
    if (found) return found;
  }
  return null;
}

function findTextByPattern(nodes: UiNode | UiNode[], pattern: RegExp): string | null {
  return findText(nodes, pattern);
}

function findTextByResourceId(node: UiNode | UiNode[], pattern: RegExp): string | null {
  const nodes = Array.isArray(node) ? node : [node];
  for (const n of nodes) {
    if (n.resourceId && pattern.test(n.resourceId) && n.text) return n.text;
    const found = findTextByResourceId(n.children ?? [], pattern);
    if (found) return found;
  }
  return null;
}

function findByResourceIdPattern(nodes: UiNode[], pattern: RegExp): UiNode[] {
  const found: UiNode[] = [];
  const visit = (n: UiNode) => {
    if (n.resourceId && pattern.test(n.resourceId)) found.push(n);
    n.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return found;
}

function findTextNear(nodes: UiNode[], keyword: string): string | null {
  const allTexts = collectText(nodes);
  const idx = allTexts.findIndex(t => t.toLowerCase().includes(keyword.toLowerCase()));
  if (idx === -1) return null;
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
