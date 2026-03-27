/**
 * skills/constants.ts
 * Shared constants for the skills system
 */

/**
 * CD_MAP — Maps element name fragments to A11y contentDescription values.
 * Used by cascade tap to derive contentDescription from visual_hint or elementName
 * when no explicit selector is available.
 */
export const CD_MAP: ReadonlyArray<{ pattern: string; cd: string }> = [
  { pattern: "like",    cd: "Like" },
  { pattern: "heart",   cd: "Like" },
  { pattern: "unlike",  cd: "Unlike" },
  { pattern: "follow",  cd: "Follow" },
  { pattern: "comment", cd: "Comment" },
  { pattern: "share",   cd: "Share" },
  { pattern: "save",    cd: "Save" },
  { pattern: "search",  cd: "Search and explore" },
  { pattern: "home",    cd: "Home" },
  { pattern: "profile", cd: "Profile" },
  { pattern: "reels",   cd: "Reels" },
  { pattern: "explore", cd: "Search and explore" },
  { pattern: "camera",  cd: "Camera" },
  { pattern: "direct",  cd: "Direct" },
  { pattern: "message", cd: "Direct" },
  { pattern: "back",    cd: "Back" },
  { pattern: "close",   cd: "Close" },
  { pattern: "more",    cd: "More options" },
] as const;
