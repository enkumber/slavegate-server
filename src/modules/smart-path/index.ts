/**
 * smart-path/index.ts
 * Public exports for Smart-Path module.
 */

export { smartPathService, type RecoveryAction, type SmartPathAnalysis, type SmartPathContext } from "./smart-path.service";
export { isDenyListed, DENY_LIST, SMART_PATH_SYSTEM_PROMPT, buildRecoveryUserPrompt } from "./prompts/recovery-prompt";
