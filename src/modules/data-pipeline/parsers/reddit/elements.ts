import type { KnownElement } from "../../parser-interface";

const ELEMENTS_V2024: KnownElement[] = [
  {
    name: "upvote_button",
    strategies: [
      { type: "content_description", value: "Upvote" },
      { type: "resource_id",         value: "com.reddit.frontpage:id/vote_up_button" },
    ],
    compatibleVersions: ["2024+"],
  },
  {
    name: "downvote_button",
    strategies: [
      { type: "content_description", value: "Downvote" },
      { type: "resource_id",         value: "com.reddit.frontpage:id/vote_down_button" },
    ],
    compatibleVersions: ["2024+"],
  },
  {
    name: "comment_button",
    strategies: [
      { type: "content_description", value: "Comments" },
      { type: "resource_id",         value: "com.reddit.frontpage:id/comment_button" },
    ],
    compatibleVersions: ["2024+"],
  },
  {
    name: "share_button",
    strategies: [
      { type: "content_description", value: "Share" },
      { type: "resource_id",         value: "com.reddit.frontpage:id/share_button" },
    ],
    compatibleVersions: ["2024+"],
  },
  {
    name: "join_button",
    strategies: [
      { type: "text_pattern",        value: "^Join$" },
      { type: "resource_id",         value: "com.reddit.frontpage:id/join_button" },
    ],
    compatibleVersions: ["2024+"],
  },
  {
    name: "home_tab",
    strategies: [
      { type: "content_description", value: "Home" },
      { type: "resource_id",         value: "com.reddit.frontpage:id/home_tab" },
    ],
    compatibleVersions: ["2024+"],
  },
  {
    name: "back_button",
    strategies: [
      { type: "content_description", value: "Back" },
      { type: "resource_id",         value: "android:id/home" },
    ],
    compatibleVersions: ["2024+"],
  },
];

export function getKnownElements(appVersion: string): KnownElement[] {
  return ELEMENTS_V2024.filter(el =>
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
