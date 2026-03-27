/**
 * vision/providers/anthropic.provider.ts
 * Claude vision provider (Sonnet/Opus) via Anthropic Messages API.
 * Uses vision natively — sends image as base64 in content array.
 */

import type { VisionProvider, VisionOptions, VisionResult, VerifyResult } from "../vision-provider.interface";

interface AnthropicConfig {
  apiKey:    string;
  model:     string;    // e.g. "claude-sonnet-4-20250514"
  endpoint?: string;    // Default: https://api.anthropic.com/v1
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export class AnthropicVisionProvider implements VisionProvider {
  readonly name = "anthropic";

  private readonly apiKey:     string;
  private readonly model:      string;
  private readonly endpoint:   string;
  private readonly maxTokens:  number;
  private readonly temperature: number;
  private readonly timeoutMs:  number;

  constructor(config: AnthropicConfig) {
    this.apiKey      = config.apiKey;
    this.model       = config.model;
    this.endpoint    = config.endpoint ?? "https://api.anthropic.com/v1";
    this.maxTokens   = config.maxTokens  ?? 512;
    this.temperature = config.temperature ?? 0.1;
    this.timeoutMs   = config.timeoutMs  ?? 15_000;
  }

  async analyze(
    screenshotBuffer: Buffer,
    prompt:           string,
    options?:         VisionOptions
  ): Promise<VisionResult> {
    const base64 = screenshotBuffer.toString("base64");
    const body = {
      model:      this.model,
      max_tokens: options?.maxTokens  ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type:       "base64",
              media_type: "image/jpeg",
              data:       base64,
            },
          },
          { type: "text", text: prompt },
        ],
      }],
    };

    const raw = await this.callApi("/messages", body, options?.timeoutMs);
    return parseAnalyzeResponse(raw);
  }

  async verify(
    screenshotBuffer:   Buffer,
    actionDescription:  string,
    options?:           VisionOptions
  ): Promise<VerifyResult> {
    const base64 = screenshotBuffer.toString("base64");
    const body = {
      model:      this.model,
      max_tokens: options?.maxTokens  ?? 256,
      temperature: options?.temperature ?? 0.1,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: base64 },
          },
          { type: "text", text: actionDescription },
        ],
      }],
    };

    const raw = await this.callApi("/messages", body, options?.timeoutMs);
    return parseVerifyResponse(raw);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/models`, {
        headers: {
          "x-api-key":         this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async callApi(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(`${this.endpoint}${path}`, {
        method: "POST",
        headers: {
          "content-type":      "application/json",
          "x-api-key":         this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText);
        throw new Error(`Anthropic API ${res.status}: ${err}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Response parsers ─────────────────────────────────────────────────────────

function parseAnalyzeResponse(raw: unknown): VisionResult {
  try {
    const response = raw as {
      content: Array<{ text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text    = response.content?.[0]?.text ?? "{}";
    // Model should return JSON — extract JSON block if wrapped in markdown
    const jsonStr = extractJson(text);
    const parsed  = JSON.parse(jsonStr);
    const tokensUsed = response.usage
      ? (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0)
      : undefined;
    return {
      elements:         (parsed.elements ?? []).map(normalizeElement),
      sceneDescription: parsed.scene_description ?? parsed.sceneDescription ?? "",
      detectedState:    parsed.detected_state ?? parsed.detectedState ?? null,
      tokensUsed,
      _rawResponse:     raw,
    };
  } catch (e) {
    console.error("[anthropic] Failed to parse analyze response:", e);
    return { elements: [], sceneDescription: "", detectedState: null, _rawResponse: raw };
  }
}

function parseVerifyResponse(raw: unknown): VerifyResult {
  try {
    const response = raw as {
      content: Array<{ text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text    = response.content?.[0]?.text ?? "{}";
    const jsonStr = extractJson(text);
    const parsed  = JSON.parse(jsonStr);
    return {
      success:     Boolean(parsed.success),
      confidence:  Number(parsed.confidence ?? 0),
      observation: String(parsed.observation ?? ""),
      tokensUsed:  (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    };
  } catch (e) {
    console.error("[anthropic] Failed to parse verify response:", e);
    return { success: false, confidence: 0, observation: "Parse error", tokensUsed: 0 };
  }
}

function normalizeElement(el: Record<string, unknown>) {
  const raw = el.bounds as Record<string, unknown> | undefined;
  const bounds = validateBounds({
    x:      Number(raw?.x      ?? 0),
    y:      Number(raw?.y      ?? 0),
    width:  Number(raw?.width  ?? 0),
    height: Number(raw?.height ?? 0),
  });
  return {
    type:       String(el.type ?? "unknown"),
    text:       el.text ? String(el.text) : null,
    bounds,
    confidence: Math.min(1, Math.max(0, Number(el.confidence ?? 0.8))),
  };
}

/**
 * Clamp bounds to safe ranges — VLM may return negative or out-of-range coords.
 * Max screen size: 4096×4096 (generous upper bound for any Android device).
 */
function validateBounds(b: { x: number; y: number; width: number; height: number }) {
  return {
    x:      Math.max(0,    isFinite(b.x)      ? Math.round(b.x)      : 0),
    y:      Math.max(0,    isFinite(b.y)      ? Math.round(b.y)      : 0),
    width:  Math.max(1,    isFinite(b.width)  ? Math.round(b.width)  : 1),
    height: Math.max(1,    isFinite(b.height) ? Math.round(b.height) : 1),
  };
}

/** Extract JSON from model output that may wrap it in markdown code blocks */
function extractJson(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}
