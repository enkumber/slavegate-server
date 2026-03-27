/**
 * Known UI elements for Instagram — used by workflow steps to find targets.
 * Strategies listed in priority order (most reliable first).
 * Update `compatibleVersions` when verifying element presence on new IG builds.
 */

import type { KnownElement } from "../../parser-interface";

const ELEMENTS_V300: KnownElement[] = [
  {
    name: "like_button",
    strategies: [
      { type: "resource_id",         value: "com.instagram.android:id/like_button" },
      { type: "content_description", value: "Like" },
      { type: "content_description", value: "Unlike" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "comment_button",
    strategies: [
      { type: "resource_id",         value: "com.instagram.android:id/comment_button" },
      { type: "content_description", value: "Comment" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "follow_button",
    strategies: [
      { type: "resource_id",         value: "com.instagram.android:id/button_follow" },
      { type: "text_pattern",        value: "^Follow$" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "following_button",
    strategies: [
      { type: "text_pattern",        value: "^Following$" },
      { type: "resource_id",         value: "com.instagram.android:id/button_follow" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "feed_tab",
    strategies: [
      { type: "resource_id",         value: "com.instagram.android:id/feed_tab" },
      { type: "content_description", value: "Home" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "reels_tab",
    strategies: [
      { type: "resource_id",         value: "com.instagram.android:id/clips_tab" },
      { type: "content_description", value: "Reels" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "back_button",
    strategies: [
      { type: "content_description", value: "Back" },
      { type: "resource_id",         value: "android:id/home" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "post_author_avatar",
    strategies: [
      { type: "resource_id",         value: "com.instagram.android:id/avatar_image_view" },
      { type: "content_description", value: "Profile picture" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "video_tab",
    strategies: [
      { type: "resource_id",         value: "com.instagram.android:id/clips_tab" },
      { type: "content_description", value: "Reels" },
    ],
    compatibleVersions: ["300+"],
  },
  {
    name: "video_player",
    strategies: [
      { type: "resource_id",         value: "com.instagram.android:id/reel_viewer_container" },
      { type: "class_position",      value: "android.view.SurfaceView:0" },
    ],
    compatibleVersions: ["300+"],
  },
];

export function getKnownElements(appVersion: string): KnownElement[] {
  // For now: single version set. Phase 3+: version-branched element sets.
  return ELEMENTS_V300.filter(el =>
    !el.compatibleVersions ||
    el.compatibleVersions.some(v => {
      if (v.endsWith("+")) {
        const min = parseInt(v.slice(0, -1), 10);
        const cur = parseInt(appVersion.split(".")[0], 10);
        return !isNaN(min) && !isNaN(cur) && cur >= min;
      }
      return appVersion.startsWith(v);
    })
  );
}
