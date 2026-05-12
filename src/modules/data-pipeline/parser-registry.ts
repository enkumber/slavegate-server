/**
 * data-pipeline/parser-registry.ts
 * Loads and manages platform parsers. Auto-discovers parsers in parsers/ subdirectories.
 * Each platform folder must export a default class implementing PlatformParser.
 */

import type { PlatformParser } from "./parser-interface";

class ParserRegistry {
  private parsers = new Map<string, PlatformParser>();

  /**
   * Register a parser manually (or auto-discovered at startup).
   * Replaces existing parser for the same platform (for hot-reload / OTA parser updates).
   */
  register(parser: PlatformParser): void {
    this.parsers.set(parser.platform, parser);
    console.log(`[parser-registry] Registered parser: ${parser.platform} v${parser.version}`);
  }

  /**
   * Get parser for a platform. Returns null if not registered.
   * Callers should handle null — new platforms can be added without breaking existing ones.
   */
  get(platform: string): PlatformParser | null {
    return this.parsers.get(platform) ?? null;
  }

  /**
   * Get parser and validate compatibility with the device's app version.
   * If incompatible: returns null + logs alert (workflow should stop).
   */
  getCompatible(platform: string, appVersion: string): PlatformParser | null {
    const parser = this.parsers.get(platform);
    if (!parser) {
      console.error(`[parser-registry] No parser registered for platform: ${platform}`);
      return null;
    }
    if (!parser.isCompatible(appVersion)) {
      console.error(
        `[parser-registry] Parser ${platform} v${parser.version} incompatible with app v${appVersion}. ` +
        `Compatible versions: ${parser.compatibleAppVersions.join(", ")}. ` +
        `STOP workflow — update parser.`
      );
      return null;
    }
    return parser;
  }

  listPlatforms(): string[] {
    return Array.from(this.parsers.keys());
  }
}

export const parserRegistry = new ParserRegistry();

/**
 * Bootstrap — register all known parsers at startup.
 * Add new platforms here when implementing Phase 3 parsers.
 */
export async function bootstrapParsers(): Promise<void> {
  const { InstagramParser } = await import("./parsers/instagram/parser");
  const { TikTokParser }    = await import("./parsers/tiktok/parser");
  const { RedditParser }    = await import("./parsers/reddit/parser");
  parserRegistry.register(new InstagramParser());
  parserRegistry.register(new TikTokParser());
  parserRegistry.register(new RedditParser());
  console.log("[parser-registry] Bootstrap complete. Registered platforms:", parserRegistry.listPlatforms());
}
