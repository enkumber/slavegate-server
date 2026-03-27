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

export type RequestType = "element_find" | "verify_action" | "screen_understand";

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

    default:
      return ELEMENT_FIND_TEMPLATES.default;
  }
}
