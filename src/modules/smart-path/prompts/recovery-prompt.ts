/**
 * recovery-prompt.ts
 * VLM prompt for Smart-Path screen analysis and recovery action determination.
 */

export const SMART_PATH_SYSTEM_PROMPT = `You are a mobile UI recovery expert. Given the current screenshot and accessibility tree, analyze what went wrong and determine the best recovery action.

CRITICAL RULES:
1. NEVER suggest recovering from DENY-LIST actions (Log Out, Delete Account, Payment, etc.)
2. If the target element is not visible, check if scrolling would help
3. If a popup/dialog is blocking, suggest dismissing it
4. If on the wrong screen, suggest navigation to get to the correct screen
5. If unsure, prefer 'escalate' over guessing

OUTPUT: Return ONLY valid JSON matching this schema:
{
  "analysis": "brief description (1-2 sentences)",
  "current_screen": "feed|home|post_detail|profile|settings|popup|dialog|unknown",
  "blocking_element": "element_id or null if none",
  "recovery_action": {
    "type": "dismiss|wait|scroll|retry|navigate_back|escalate",
    "target": "element_id or 'outside' or null",
    "direction": "up|down|left|right or null",
    "params": {}
  },
  "deny_list": true|false,
  "confidence": 0.0-1.0
}`;

export function buildRecoveryUserPrompt(
  failedStep: {
    action: string;
    target: string;
    expectedScreen: string;
  },
  errorDescription: string,
  uiTree: string
): string {
  return `STEP THAT FAILED:
- Action: ${failedStep.action}
- Target: ${failedStep.target}
- Expected screen: ${failedStep.expectedScreen}

ERROR FROM DEVICE:
${errorDescription}

UI_ACCESSIBILITY_TREE:
${uiTree}

ANALYZE the current screen and determine the best recovery action.`;
}

export const DENY_LIST = [
  // Logout/Sign out
  "log_out",
  "logout",
  "sign_out",
  "signout",
  "Log Out",
  "Log Out",
  "Sign Out",
  "Disconnect",

  // Delete/Remove
  "delete_account",
  "delete account",
  "Delete Account",
  "delete",
  "remove_account",
  "Remove Account",
  "remove",
  "Uninstall",
  "delete_item",
  "Remove Item",

  // Payment/Money
  "payment",
  "pay",
  "Purchase",
  "Buy",
  "send_money",
  "transfer",
  "Wire Transfer",
  "Add Payment",
  "Remove Payment",
  "Buy Now",
  "Checkout",

  // Security sensitive
  "reset_password",
  "Reset Password",
  "forgot_password",
  "settings.reset",
  "Reset Settings",
  "clear_data",
  "Clear Data",
  "Clear Cache",
  "grant_permission",
  "Grant Permission",
  "revoke_permission",
  "Revoke Permission",
  "disable_2fa",
  "Enable 2FA",
  "Turn Off 2FA",

  // Content deletion
  "delete_post",
  "Delete Post",
  "delete_comment",
  "Delete Comment",
  "delete_message",
  "Delete Message",
  "unsend",
  "Unsend",

  // Account changes
  "change_password",
  "Change Password",
  "update_email",
  "Update Email",
  "update_phone",
  "Update Phone",
  "change_username",
  "Change Username",
];

/**
 * Check if a target element is on the deny-list.
 */
export function isDenyListed(target: string): boolean {
  if (!target) return false;
  const normalized = target.toLowerCase().replace(/[._]/g, " ");
  return DENY_LIST.some(blocked =>
    normalized.includes(blocked.toLowerCase())
  );
}
