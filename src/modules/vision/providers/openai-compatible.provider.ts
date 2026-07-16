/**
 * vision/providers/openai-compatible.provider.ts
 * OpenAI-compatible vision provider.
 * Works with: OpenAI GPT-4o, local Qwen3-VL via vLLM/Ollama/TGI.
 *
 * Swap from cloud to local: change endpoint + model in vision_config DB row.
 * Zero code change required — same provider class handles both.
 */

import type { VisionProvider, VisionOptions, VisionResult, VerifyResult } from "../vision-provider.interface";
import { modelConfigFetch, sanitizeProviderError } from "../../model-config/model-config.service";

interface OpenAICompatibleConfig {
  apiKey:      string;
  model:       string;    // "gpt-4o", "qwen3-vl-8b", etc.
  endpoint?:   string;    // Default: https://api.openai.com/v1
  maxTokens?:  number;
  temperature?: number;
  timeoutMs?:  number;
}

export class OpenAICompatibleProvider implements VisionProvider {
  readonly name: string;

  private readonly apiKey:      string;
  private readonly model:       string;
  private readonly endpoint:    string;
  private readonly maxTokens:   number;
  private readonly temperature: number;
  private readonly timeoutMs:   number;

  constructor(config: OpenAICompatibleConfig) {
    this.apiKey      = config.apiKey;
    this.model       = config.model;
    this.endpoint    = config.endpoint ?? "https://api.openai.com/v1";
    this.maxTokens   = config.maxTokens   ?? 512;
    this.temperature = config.temperature ?? 0.1;
    this.timeoutMs   = config.timeoutMs   ?? 15_000;
    this.name        = config.endpoint?.includes("openai.com") ? "openai" : "openai_compatible";
  }

  async analyze(
    screenshotBuffer: Buffer,
    prompt:           string,
    options?:         VisionOptions
  ): Promise<VisionResult> {
    const base64 = screenshotBuffer.toString("base64");
    const body = {
      model:       this.model,
      max_tokens:  options?.maxTokens  ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      messages: [{
        role: "user",
        content: [
          {
            type:      "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64}`, detail: "high" },
          },
          { type: "text", text: prompt },
        ],
      }],
    };

    const raw = await this.callApi("/chat/completions", body, options?.timeoutMs);
    return parseAnalyzeResponse(raw, this.model);
  }

  async verify(
    screenshotBuffer:   Buffer,
    actionDescription:  string,
    options?:           VisionOptions
  ): Promise<VerifyResult> {
    const base64 = screenshotBuffer.toString("base64");
    const body = {
      model:       this.model,
      max_tokens:  256,
      temperature: 0.1,
      messages: [{
        role: "user",
        content: [
          {
            type:      "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64}`, detail: "low" },
          },
          { type: "text", text: actionDescription },
        ],
      }],
    };

    const raw = await this.callApi("/chat/completions", body, options?.timeoutMs);
    return parseVerifyResponse(raw);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await modelConfigFetch(`${this.endpoint}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      }, "vision_vlm");
      return res.ok;
    } catch {
      return false;
    }
  }

  private async callApi(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await modelConfigFetch(`${this.endpoint}${path}`, {
        method:  "POST",
        headers: {
          "content-type":  "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body:   JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      }, "vision_vlm");
      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText);
        throw new Error(`${this.name} API ${res.status}: ${sanitizeProviderError(err)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Response parsers ─────────────────────────────────────────────────────────

function parseAnalyzeResponse(raw: unknown, model: string): VisionResult {
  try {
    const response = raw as {
      choices: Array<{ message: { content: string } }>;
      usage?:  { prompt_tokens: number; completion_tokens: number };
    };
    const text    = response.choices?.[0]?.message?.content ?? "{}";
    const jsonStr = extractJson(text);
    const parsed  = JSON.parse(jsonStr);
    const tokensUsed = response.usage
      ? (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0)
      : undefined;
    return {
      elements:         (parsed.elements ?? []).map(normalizeElement),
      sceneDescription: parsed.scene_description ?? parsed.sceneDescription ?? "",
      detectedState:    parsed.detected_state ?? parsed.detectedState ?? null,
      tokensUsed,
      _rawResponse:     raw,
    };
  } catch (e) {
    console.error(`[${model}] Failed to parse analyze response:`, e);
    return { elements: [], sceneDescription: "", detectedState: null, _rawResponse: raw };
  }
}

function parseVerifyResponse(raw: unknown): VerifyResult {
  try {
    const response = raw as {
      choices: Array<{ message: { content: string } }>;
      usage?:  { prompt_tokens: number; completion_tokens: number };
    };
    const text    = response.choices?.[0]?.message?.content ?? "{}";
    const jsonStr = extractJson(text);
    const parsed  = JSON.parse(jsonStr);
    const usage   = (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0);
    return {
      success:     Boolean(parsed.success),
      confidence:  Number(parsed.confidence ?? 0),
      observation: String(parsed.observation ?? ""),
      tokensUsed:  usage,
    };
  } catch (e) {
    console.error("[openai] Failed to parse verify response:", e);
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

function validateBounds(b: { x: number; y: number; width: number; height: number }) {
  return {
    x:      Math.max(0, isFinite(b.x)      ? Math.round(b.x)      : 0),
    y:      Math.max(0, isFinite(b.y)      ? Math.round(b.y)      : 0),
    width:  Math.max(1, isFinite(b.width)  ? Math.round(b.width)  : 1),
    height: Math.max(1, isFinite(b.height) ? Math.round(b.height) : 1),
  };
}

function extractJson(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}
