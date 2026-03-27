/**
 * skills module (P2)
 * Skill file management and cascade navigation
 */

export * from './types';
export * from './skill.service';
export * from './skill-db.service';
export { coordCacheService } from './skill-db.service';
export type { DeviceInfo, CachedCoord, LearnCoordInput } from './skill-db.service';
// Note: skill.cascade.ts has duplicate cascade implementation - use skill.service.ts instead
// Export only specific functions to avoid type conflicts
export { executeCascadeTap, resolveCascadeResult } from './skill.cascade';
// Export target-parser functions (types are already in ./types)
export { 
  parseTarget, 
  isSkillRef, 
  getSessionLearnedCoords, 
  setSessionLearnedCoords,
  clearSessionLearning,
  getSessionLearningStats,
  startSessionLearningCleanup,
  stopSessionLearningCleanup,
} from './target-parser';
// Re-export ParsedTarget from target-parser (extends the one in types.ts)
export type { ParsedTarget } from './target-parser';
