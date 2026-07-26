const CAPABILITY_KEY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
import type { WorkflowTemplate } from "../workflows/types";

export function portableCapabilityMetadata(
  _workflow: WorkflowTemplate,
  sourceMetadata: Record<string, unknown>,
): { capabilityKey?: string; portable: boolean; portabilityScope?: string } {
  const explicit = typeof sourceMetadata.capabilityKey === "string"
    && CAPABILITY_KEY_RE.test(sourceMetadata.capabilityKey)
    ? sourceMetadata.capabilityKey
    : null;
  const portable = sourceMetadata.portable === true;
  const portabilityScope = typeof sourceMetadata.portabilityScope === "string"
    && /^[a-z0-9][a-z0-9._/-]{0,199}$/.test(sourceMetadata.portabilityScope)
    ? sourceMetadata.portabilityScope
    : undefined;
  return {
    ...(explicit ? { capabilityKey: explicit } : {}),
    portable,
    ...(portabilityScope ? { portabilityScope } : {}),
  };
}
