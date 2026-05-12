/**
 * vision/vision-provider.interface.ts
 * VLM provider adapter interface — swap providers via config, zero code change.
 *
 * Current providers:
 *   - AnthropicVisionProvider (Claude Sonnet/Opus — cloud)
 *   - OpenAICompatibleProvider (OpenAI cloud OR local Qwen3-VL via vLLM/Ollama)
 *
 * Swap: change vision_config row in DB — service auto-routes to correct adapter.
 * Reference: ARCHITECTURE_AUDIT_v3.md §4.4
 */

// ─── Input types ──────────────────────────────────────────────────────────────

export interface VisionOptions {
  maxTokens?:   number;
  temperature?: number;
  timeoutMs?:   number;
}

// ─── Output types ─────────────────────────────────────────────────────────────

export interface VisionElement {
  type:       string;   // "button" | "text" | "image" | "input" | "container"
  text:       string | null;
  bounds:     { x: number; y: number; width: number; height: number };
  confidence: number;   // 0.0 - 1.0
}

export interface VisionResult {
  elements:         VisionElement[];
  sceneDescription: string;
  detectedState:    string | null;
  /** Real token count from provider API (input + output). Preferred over estimation for vlm_usage_log. */
  tokensUsed?:      number;
  /** Raw model response — for debugging only, never forwarded to device */
  _rawResponse?:   unknown;
}

export interface VerifyResult {
  success:     boolean;
  confidence:  number;      // 0.0 - 1.0
  observation: string;      // Human-readable explanation
  tokensUsed:  number;
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface VisionProvider {
  readonly name: string;

  /**
   * Analyze screenshot — return structured elements and scene description.
   * Server constructs prompt from template — provider never receives raw user input.
   */
  analyze(
    screenshotBuffer: Buffer,
    prompt:           string,   // Server-generated from template — NOT from device
    options?:         VisionOptions
  ): Promise<VisionResult>;

  /**
   * Verify action success — "did action X succeed?"
   * Returns success + confidence + observation.
   */
  verify(
    screenshotBuffer:    Buffer,
    actionDescription:  string,  // Server-generated — NOT from device
    options?:           VisionOptions
  ): Promise<VerifyResult>;

  /** Health check — returns true if provider is reachable */
  healthCheck(): Promise<boolean>;
}
