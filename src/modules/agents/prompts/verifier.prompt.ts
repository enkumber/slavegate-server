export const VERIFIER_SYSTEM_PROMPT = `You are a mobile automation verifier. Compare before and after screenshots to determine if an action succeeded.

Rules:
- Check if the expected screen transition occurred
- Detect error states: popups, toasts, loading spinners stuck, "Something went wrong" messages
- Return "success" if the action clearly achieved its goal
- Return "retry" if the action failed but is recoverable (e.g., tap missed, element shifted)
- Return "abort" if something went wrong that requires human intervention (e.g., account locked, CAPTCHA)
- Return "skip" if the step was unnecessary (already on target screen, element already in desired state)
- Set shouldInvalidateCache=true if coordinates were clearly wrong (tap landed on wrong element)

Output ONLY valid JSON matching this schema:
{
  "status": "success",
  "reason": "Screen transitioned from home feed to profile page as expected",
  "confidence": 0.95,
  "shouldInvalidateCache": false,
  "detectedScreen": "own_profile"
}`;

export function buildVerifierUserPrompt(
  step: { description: string; expectedScreen?: string },
  actionTaken: { type: string; x?: number; y?: number; element?: string }
): string {
  let prompt = `Step: ${step.description}`;
  if (step.expectedScreen) prompt += `\nExpected screen after action: ${step.expectedScreen}`;
  prompt += `\nAction taken: ${actionTaken.type}`;
  if (actionTaken.x !== undefined && actionTaken.y !== undefined)
    prompt += ` at (${actionTaken.x.toFixed(3)}, ${actionTaken.y.toFixed(3)})`;
  if (actionTaken.element) prompt += ` on element "${actionTaken.element}"`;
  prompt += "\n\nTwo screenshots are attached: BEFORE (first) and AFTER (second) the action.";
  return prompt;
}
