import type { KnownElement } from "../../parser-interface";

const ELEMENTS_V30: KnownElement[] = [
  {
    name: "like_button",
    strategies: [
      { type: "resource_id",         value: "com.zhiliaoapp.musically:id/kh8" },
      { type: "content_description", value: "Like" },
      { type: "content_description", value: "Liked" },
    ],
    compatibleVersions: ["30+"],
  },
  {
    name: "comment_button",
    strategies: [
      { type: "resource_id",         value: "com.zhiliaoapp.musically:id/comment" },
      { type: "content_description", value: "Comment" },
    ],
    compatibleVersions: ["30+"],
  },
  {
    name: "follow_button",
    strategies: [
      { type: "resource_id",         value: "com.zhiliaoapp.musically:id/follow_btn" },
      { type: "text_pattern",        value: "^Follow$" },
    ],
    compatibleVersions: ["30+"],
  },
  {
    name: "share_button",
    strategies: [
      { type: "content_description", value: "Share" },
      { type: "resource_id",         value: "com.zhiliaoapp.musically:id/share" },
    ],
    compatibleVersions: ["30+"],
  },
  {
    name: "home_tab",
    strategies: [
      { type: "content_description", value: "Home" },
      { type: "resource_id",         value: "com.zhiliaoapp.musically:id/home_tab" },
    ],
    compatibleVersions: ["30+"],
  },
  {
    name: "video_player",
    strategies: [
      { type: "class_position",      value: "android.view.SurfaceView:0" },
      { type: "resource_id",         value: "com.zhiliaoapp.musically:id/video_player" },
    ],
    compatibleVersions: ["30+"],
  },
  {
    name: "back_button",
    strategies: [
      { type: "content_description", value: "Back" },
      { type: "resource_id",         value: "android:id/home" },
    ],
    compatibleVersions: ["30+"],
  },
];

export function getKnownElements(appVersion: string): KnownElement[] {
  return ELEMENTS_V30.filter(el =>
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
