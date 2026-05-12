/**
 * vision/providers/minimax.provider.ts
 * MiniMax vision provider (MiniMax-M2.7) via MiniMax Anthropic-compatible API.
 * Supports vision: image_url blocks in messages array.
 * Uses x-api-key auth header (authHeader: true).
 */

import type { VisionProvider, VisionOptions, VisionResult, VerifyResult } from "../vision-provider.interface";

interface MiniMaxConfig {
  apiKey:      string;
  model:       string;    // e.g. "MiniMax-M2.7"
  endpoint?:   string;    // Default: https://api.minimax.io/anthropic/v1
  maxTokens?:  number;
  temperature?: number;
  timeoutMs?:  number;
}

export class MiniMaxVisionProvider implements VisionProvider {
  readonly name = "minimax";

  private readonly apiKey:      string;
  private readonly model:       string;
  private readonly endpoint:    string;
  private readonly maxTokens:   number;
  private readonly temperature: number;
  private readonly timeoutMs:  number;

  constructor(config: MiniMaxConfig) {
    this.apiKey      = config.apiKey;
    this.model       = config.model;
    this.endpoint    = config.endpoint ?? "https://api.minimax.io/anthropic/v1";
    this.maxTokens   = config.maxTokens   ?? 1024;
    this.temperature = config.temperature ?? 0.1;
    this.timeoutMs   = config.timeoutMs   ?? 30_000;
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
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: base64,
            },
          },
          { type: "text", text: prompt },
        ],
      }],
    };

    const response = await this.fetch("/messages", body);
    return this.parseAnalyzeResponse(response);
  }

  async verify(
    screenshotBuffer:   Buffer,
    actionDescription: string,
    options?:           VisionOptions
  ): Promise<VerifyResult> {
    const base64 = screenshotBuffer.toString("base64");
    const body = {
      model:       this.model,
      max_tokens:  options?.maxTokens  ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: base64,
            },
          },
          {
            type: "text",
            text: `Verify this action: "${actionDescription}". Did it succeed? ` +
              `Respond with JSON: {"success": true/false, "confidence": 0.0-1.0, "observation": "what you see"}.`,
          },
        ],
      }],
    };

    const response = await this.fetch("/messages", body);
    return this.parseVerifyResponse(response);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const body = {
        model: this.model,
        max_tokens: 10,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      };
      await this.fetch("/messages", body);
      return true;
    } catch {
      return false;
    }
  }

  private async fetch(path: string, body: unknown): Promise<unknown> {
    const url = `${this.endpoint}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type":                 "application/json",
          "x-api-key":                    this.apiKey,
          "anthropic-version":            "2023-06-01",
          "anthropic-dangerous-direct-www-access": "true",
        },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MiniMax API error ${res.status}: ${text}`);
      }

      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseAnalyzeResponse(raw: unknown): VisionResult {
    try {
      const response = raw as {
        content?: Array<{ type: string; text?: string }>;
        usage?:   { input_tokens: number; output_tokens: number };
      };

      const content = response.content?.find((b) => b.type === "text");
      const text    = content?.text ?? "{}";
      const jsonStr = this.extractJson(text);
      const parsed  = JSON.parse(jsonStr);

      const tokensUsed = response.usage
        ? (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0)
        : undefined;

      return {
        elements:         (parsed.elements ?? []).map(this.normalizeElement),
        sceneDescription: parsed.scene_description ?? parsed.sceneDescription ?? "",
        detectedState:    parsed.detected_state ?? parsed.detectedState ?? null,
        tokensUsed,
        _rawResponse:     raw,
      };
    } catch (e) {
      console.error("[minimax] Failed to parse analyze response:", e);
      return { elements: [], sceneDescription: "", detectedState: null, _rawResponse: raw };
    }
  }

  private parseVerifyResponse(raw: unknown): VerifyResult {
    try {
      const response = raw as {
        content?: Array<{ type: string; text?: string }>;
        usage?:   { input_tokens: number; output_tokens: number };
      };

      const content = response.content?.find((b) => b.type === "text");
      const text    = content?.text ?? "{}";
      const jsonStr = this.extractJson(text);
      const parsed  = JSON.parse(jsonStr);
      const usage   = response.usage
        ? (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0)
        : 0;

      return {
        success:    Boolean(parsed.success),
        confidence: Number(parsed.confidence ?? 0),
        observation: String(parsed.observation ?? ""),
        tokensUsed:  usage,
      };
    } catch (e) {
      console.error("[minimax] Failed to parse verify response:", e);
      return { success: false, confidence: 0, observation: "Parse error", tokensUsed: 0 };
    }
  }

  private normalizeElement(el: Record<string, unknown>) {
    const raw   = el.bounds as Record<string, unknown> | undefined;
    const bounds = this.validateBounds({
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

  private validateBounds(b: { x: number; y: number; width: number; height: number }) {
    return {
      x:      Math.max(0, isFinite(b.x)      ? Math.round(b.x)      : 0),
      y:      Math.max(0, isFinite(b.y)      ? Math.round(b.y)      : 0),
      width:  Math.max(1, isFinite(b.width)  ? Math.round(b.width)  : 1),
      height: Math.max(1, isFinite(b.height) ? Math.round(b.height) : 1),
    };
  }

  private extractJson(text: string): string {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    const start = text.indexOf("{");
    const end   = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) return text.slice(start, end + 1);
    return text.trim();
  }
}
