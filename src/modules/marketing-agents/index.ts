/**
 * marketing-agents module
 * All spawnable agents for Nautilus
 */

// Re-export main runner functions only (avoid type conflicts)
export { runBusinessAnalyst, BAResult, BAConfig } from './business-analyst/ba.service';
export { runMarketer, MarketerResult, MarketerConfig } from './marketer/marketer.service';
export { runSiren, SirenResult, SirenConfig } from './siren/siren.service';
export { runTactician, TacticianResult, TacticianConfig } from './tactician/tactician.service';
