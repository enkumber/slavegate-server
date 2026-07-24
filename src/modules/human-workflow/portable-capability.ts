const CAPABILITY_KEY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
import type { WorkflowTemplate } from "../workflows/types";

export function portableCapabilityMetadata(
  _workflow: WorkflowTemplate,
  sourceMetadata: Record<string, unknown>,
): { capabilityKey?: string; portable: boolean; portabilityScope: "global" | "contextual" } {
  const explicit = typeof sourceMetadata.capabilityKey === "string"
    && CAPABILITY_KEY_RE.test(sourceMetadata.capabilityKey)
    ? sourceMetadata.capabilityKey
    : null;
  const portable = sourceMetadata.portable === true
    && sourceMetadata.portabilityScope === "global";
  return {
    ...(explicit ? { capabilityKey: explicit } : {}),
    portable,
    portabilityScope: portable ? "global" : "contextual",
  };
}
