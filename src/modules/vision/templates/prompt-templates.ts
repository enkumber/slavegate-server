/**
 * vision/templates/prompt-templates.ts
 * Server-side prompt templates for VLM requests.
 *
 * SECURITY: Prompts are constructed exclusively here — device sends ONLY:
 *   { requestType, actionType, jobId, screenshotBase64 }
 * No user-controlled strings ever reach the VLM. Anti prompt-injection.
 *
 * Template selection: requestType + actionType → specific prompt.
 * Output format: JSON with typed structure — parser-safe.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §4, §5.4
 */

// ─── Template key ─────────────────────────────────────────────────────────────

export type RequestType = "element_find" | "verify_action" | "screen_understand" | "screen_classification";

export interface PromptContext {
  requestType: RequestType;
  actionType:  string;  // e.g. "tap_like", "scroll_feed", "tap_follow"
}

// ─── Templates ────────────────────────────────────────────────────────────────

const ELEMENT_FIND_TEMPLATES: Record<string, string> = {
  like_button: `Analyze this Android app screenshot. Find the "like" button (heart icon, thumbs up, or similar engagement button).
Return JSON:
{"elements": [{"type": "button", "text": null, "bounds": {"x": <int>, "y": <int>, "width": <int>, "height": <int>}, "confidence": <0.0-1.0>}], "scene_description": "<brief>", "detected_state": "<feed|post_detail|unknown>"}
If not found, return empty elements array.`,

  follow_button: `Analyze this Android app screenshot. Find the "Follow" or "Following" button near a user profile.
Return JSON:
{"elements": [{"type": "button", "text": "<Follow|Following>", "bounds": {"x": <int>, "y": <int>, "width": <int>, "height": <int>}, "confidence": <0.0-1.0>}], "scene_description": "<brief>", "detected_state": "<profile|unknown>"}`,

  comment_input: `Analyze this Android app screenshot. Find the comment input field or "Add a comment..." text box.
Return JSON:
{"elements": [{"type": "input", "text": null, "bounds": {"x": <int>, "y": <int>, "width": <int>, "height": <int>}, "confidence": <0.0-1.0>}], "scene_description": "<brief>", "detected_state": "<post_detail|unknown>"}`,

  default: `Analyze this Android app screenshot. Identify all interactive UI elements.
Return JSON:
{"elements": [{"type": "<button|text|input|image|container>", "text": "<text or null>", "bounds": {"x": <int>, "y": <int>, "width": <int>, "height": <int>}, "confidence": <0.0-1.0>}], "scene_description": "<1-2 sentences>", "detected_state": "<screen type>"}`,
};

const VERIFY_ACTION_TEMPLATES: Record<string, string> = {
  tap_like: `This is a screenshot from an Android social media app after tapping the like button.
Question: Was the like action successful? Is the like button now active/filled/highlighted (red heart, filled thumb, etc.)?
Return JSON:
{"success": <true|false>, "confidence": <0.0-1.0>, "observation": "<what you see about the like button state>"}`,

  tap_follow: `This is a screenshot from an Android social media app after tapping Follow.
Question: Was the follow action successful? Does the button now show "Following" instead of "Follow"?
Return JSON:
{"success": <true|false>, "confidence": <0.0-1.0>, "observation": "<current button state>"}`,

  scroll_feed: `This is a screenshot from an Android social media app after scrolling the feed.
Question: Is this a feed/content view showing posts or videos? Did the scroll succeed (is there content visible)?
Return JSON:
{"success": <true|false>, "confidence": <0.0-1.0>, "observation": "<what content is visible>"}`,

  open_app: `This is a screenshot from an Android device.
Question: Is a social media app open and loaded (showing a feed, profile, or main content screen, NOT a loading spinner or error)?
Return JSON:
{"success": <true|false>, "confidence": <0.0-1.0>, "observation": "<what screen is showing>"}`,

  tap_comment: `This is a screenshot from an Android social media app after tapping the comment button.
Question: Is the comment section open or is a comment input field visible?
Return JSON:
{"success": <true|false>, "confidence": <0.0-1.0>, "observation": "<comment section state>"}`,

  default: `This is a screenshot from an Android social media app after performing an action.
Question: Did the action appear to succeed? Did the UI change in a meaningful way?
Return JSON:
{"success": <true|false>, "confidence": <0.0-1.0>, "observation": "<what changed or did not change>"}`,
};

const SCREEN_UNDERSTAND_TEMPLATES: Record<string, string> = {
  default: `Analyze this Android app screenshot completely.
Identify:
1. Which app and screen type is this (feed, profile, post detail, story, search, etc.)
2. All visible interactive elements
3. Any unusual states (error, CAPTCHA, ban notice, rate limit warning, login prompt)

Return JSON:
{
  "elements": [{"type": "<type>", "text": "<text|null>", "bounds": {"x": <int>, "y": <int>, "width": <int>, "height": <int>}, "confidence": <float>}],
  "scene_description": "<2-3 sentences describing the screen>",
  "detected_state": "<screen type>",
  "alerts": ["<list any warnings, errors, or unusual states>"]
}`,

  challenge_check: `This is a screenshot from an Android social media app. Check if there is any security challenge, CAPTCHA, verification request, unusual warning, or account restriction message visible.
Return JSON:
{"success": false, "confidence": <0.0-1.0>, "observation": "<describe any challenge or restriction, or 'No challenge detected'"}`,

  evaluate_profile: `Analyze this Instagram profile screenshot.
Evaluate:
1. Is the account active? (recent posts visible, not private)
2. Approximate follower count?
3. What type of content do they post?
4. Profile appearance (bio, profile pic, highlights)

Return JSON:
{
  "is_active": true/false,
  "is_private": true/false,
  "followers_approx": <number or null if not visible>,
  "content_type": "<brief description>",
  "has_posts": true/false,
  "has_profile_pic": true/false,
  "confidence": <0.0-1.0>,
  "observation": "<1-2 sentences>"
}`,

  detect_block: `Analyze this Instagram screenshot for any blocking or rate limiting.
Look for:
- "Action Blocked" message
- "Try Again Later" message
- "We limit how often" message
- Any error dialogs or warnings
- CAPTCHA or verification prompts

Return JSON:
{
  "blocked": true/false,
  "block_type": "<action_blocked|rate_limited|captcha|verification|none>",
  "message": "<exact text if visible, or null>",
  "confidence": <0.0-1.0>,
  "observation": "<what you see>"
}`,

  find_element: `Analyze this Android screenshot.
Find the UI element matching this description: {{visual_hint}}

Return JSON:
{
  "found": true/false,
  "x": <pixel x coordinate of element center>,
  "y": <pixel y coordinate of element center>,
  "confidence": <0.0-1.0>,
  "element_text": "<text on element if any>",
  "observation": "<brief description>"
}

Note: Coordinates are for the ORIGINAL resolution ({{original_width}}x{{original_height}}), not the resized image.`,

  identify_screen: `Analyze this {{app_name}} screenshot.
Which screen is this?

Possible screens: {{screen_list}}

Return JSON:
{
  "screen": "<screen_name from list>",
  "confidence": <0.0-1.0>,
  "elements_visible": ["<list of visible UI elements>"],
  "observation": "<brief>"
}`,
};

// ─── Screen Classification Templates (for Screen Detection Cascade L3) ─────────

const SCREEN_CLASSIFICATION_TEMPLATES: Record<string, string> = {
  instagram: `You are a mobile UI classifier for Instagram.

Analyze this screenshot and identify the current screen.

Reply with EXACTLY this JSON format (no other text, no markdown):
{
  "screen": "<SCREEN_ID>",
  "confidence": <0.0-1.0>,
  "navBar": { "visible": <true/false>, "selectedTab": "<tab_name_or_null>" },
  "overlays": ["<OVERLAY_ID>", ...]
}

Valid SCREEN_IDs:
HOME_FEED, SEARCH_EXPLORE, SEARCH_RESULTS, REELS_TAB, REELS_FULLSCREEN,
CREATE_POST, PROFILE_OWN, PROFILE_OTHER, NOTIFICATIONS, DM_INBOX, DM_CONVERSATION,
HASHTAG_FEED, POST_DETAIL, COMMENTS_OPEN, STORY_VIEWER, STORY_CAMERA,
FOLLOWERS_LIST, FOLLOWING_LIST, SETTINGS, UNKNOWN

Valid OVERLAY_IDs (include only if actually visible):
KEYBOARD_OPEN, ACTION_SHEET, CONFIRMATION_DIALOG, SUGGESTIONS_POPUP,
LOGIN_REQUIRED, ACTION_BLOCKED

Valid selectedTab values: home, search, create, reels, profile, null

Rules:
- HOME_FEED: vertical feed with posts, home tab highlighted in bottom nav
- REELS_FULLSCREEN: fullscreen video, nav bar hidden
- REELS_TAB: reels tab highlighted in bottom nav, multiple reels visible
- PROFILE_OWN: profile with "Edit profile" or "Edit Profile" button
- PROFILE_OTHER: profile with "Follow" / "Following" / "Message" buttons
- ACTION_BLOCKED: "Action Blocked" or "Try Again Later" dialog visible
- LOGIN_REQUIRED: login form or "Log in" button visible
- KEYBOARD_OPEN: software keyboard visible at bottom of screen`,

  reddit: `You are a mobile UI classifier for Reddit.

Analyze this screenshot and identify the current screen.

Reply with EXACTLY this JSON format (no other text, no markdown):
{
  "screen": "<SCREEN_ID>",
  "confidence": <0.0-1.0>,
  "navBar": { "visible": <true/false>, "selectedTab": "<tab_name_or_null>" },
  "overlays": ["<OVERLAY_ID>", ...]
}

Valid SCREEN_IDs:
REDDIT_HOME_FEED, REDDIT_SUBREDDIT, REDDIT_POST_DETAIL, REDDIT_COMMENTS,
REDDIT_COMMENT_COMPOSE, REDDIT_SEARCH, REDDIT_SEARCH_RESULTS,
REDDIT_PROFILE_OWN, REDDIT_PROFILE_OTHER, REDDIT_INBOX, REDDIT_SETTINGS,
REDDIT_CREATE_POST, REDDIT_RATE_LIMITED, REDDIT_BANNED, REDDIT_LOGIN, UNKNOWN

Valid OVERLAY_IDs (include only if actually visible):
KEYBOARD_OPEN, CONFIRMATION_DIALOG, ACTION_SHEET

Valid selectedTab values: home, communities, create, chat, inbox, null

Rules:
- REDDIT_HOME_FEED: "For you" or "Following" feed with posts, bottom nav visible with Home selected
- REDDIT_SUBREDDIT: subreddit page with "r/Name" header, Join/Joined button, Hot/New/Top tabs
- REDDIT_POST_DETAIL: single post expanded with comments, "Add a comment" or "Join the conversation" visible
- REDDIT_COMMENTS: comments section open, comment tree visible
- REDDIT_COMMENT_COMPOSE: text input active for writing a comment/reply
- REDDIT_SEARCH: search bar with "Search Reddit" placeholder, trending topics visible
- REDDIT_SEARCH_RESULTS: search results with tabs (Posts, Comments, Communities, People)
- REDDIT_PROFILE_OWN: own profile with "Edit" button, karma count visible
- REDDIT_PROFILE_OTHER: other user profile with "Follow" or "Chat" button
- REDDIT_INBOX: notifications/messages list
- REDDIT_CREATE_POST: post composer with Title field and Community selector
- REDDIT_RATE_LIMITED: "you are doing that too much" or "try again in" message
- REDDIT_BANNED: "you have been banned" or "suspended" message
- REDDIT_LOGIN: login form with username/password fields or "Log in" button
- KEYBOARD_OPEN: software keyboard visible at bottom`,

  default: `You are a mobile UI classifier for social media automation.

Analyze this screenshot and identify the current screen.

Reply with EXACTLY this JSON format (no other text, no markdown):
{
  "screen": "<SCREEN_ID>",
  "confidence": <0.0-1.0>,
  "navBar": { "visible": <true/false>, "selectedTab": "<tab_name_or_null>" },
  "overlays": ["<OVERLAY_ID>", ...]
}

Valid SCREEN_IDs:
HOME_FEED, SEARCH_EXPLORE, SEARCH_RESULTS, REELS_TAB, REELS_FULLSCREEN,
CREATE_POST, PROFILE_OWN, PROFILE_OTHER, NOTIFICATIONS, DM_INBOX, DM_CONVERSATION,
HASHTAG_FEED, POST_DETAIL, COMMENTS_OPEN, STORY_VIEWER, STORY_CAMERA,
FOLLOWERS_LIST, FOLLOWING_LIST, SETTINGS,
REDDIT_HOME_FEED, REDDIT_SUBREDDIT, REDDIT_POST_DETAIL, REDDIT_COMMENTS,
REDDIT_COMMENT_COMPOSE, REDDIT_SEARCH, REDDIT_SEARCH_RESULTS,
REDDIT_PROFILE_OWN, REDDIT_PROFILE_OTHER, REDDIT_INBOX, REDDIT_SETTINGS,
REDDIT_CREATE_POST, REDDIT_RATE_LIMITED, REDDIT_BANNED, REDDIT_LOGIN,
UNKNOWN

Valid OVERLAY_IDs (include only if actually visible):
KEYBOARD_OPEN, ACTION_SHEET, CONFIRMATION_DIALOG, SUGGESTIONS_POPUP,
LOGIN_REQUIRED, ACTION_BLOCKED

Valid selectedTab values: home, search, create, reels, profile, communities, chat, inbox, null

Rules:
- HOME_FEED / REDDIT_HOME_FEED: vertical feed with posts, home tab highlighted
- REELS_FULLSCREEN: fullscreen video, nav bar hidden
- PROFILE_OWN / REDDIT_PROFILE_OWN: own profile with edit button
- PROFILE_OTHER / REDDIT_PROFILE_OTHER: profile with follow/message buttons
- REDDIT_SUBREDDIT: subreddit page with "r/" prefix in title
- REDDIT_POST_DETAIL: single post with comments section
- REDDIT_RATE_LIMITED: rate limit warning message
- ACTION_BLOCKED: "Action Blocked" or "Try Again Later" dialog visible
- LOGIN_REQUIRED / REDDIT_LOGIN: login form visible
- KEYBOARD_OPEN: software keyboard visible at bottom of screen`,
};

// Map detect_screen_<platform> → default template
function resolveScreenClassification(actionType: string): string {
  // Extract platform if present: detect_screen_instagram → instagram
  const platformMatch = actionType.match(/^detect_screen_(.+)$/);
  const platform = platformMatch?.[1];

  const template = SCREEN_CLASSIFICATION_TEMPLATES[platform ?? '']
    ?? SCREEN_CLASSIFICATION_TEMPLATES.default;

  return template;
}

// ─── Template resolver ────────────────────────────────────────────────────────

export function resolvePrompt(ctx: PromptContext): string {
  switch (ctx.requestType) {
    case "element_find":
      return ELEMENT_FIND_TEMPLATES[ctx.actionType]
          ?? ELEMENT_FIND_TEMPLATES.default;

    case "verify_action":
      return VERIFY_ACTION_TEMPLATES[ctx.actionType]
          ?? VERIFY_ACTION_TEMPLATES.default;

    case "screen_understand":
      return SCREEN_UNDERSTAND_TEMPLATES[ctx.actionType]
          ?? SCREEN_UNDERSTAND_TEMPLATES.default;

    case "screen_classification":
      return resolveScreenClassification(ctx.actionType);

    default:
      return ELEMENT_FIND_TEMPLATES.default;
  }
}
