/**
 * agents/llm-client.ts
 * Shared LLM client for multi-agent architecture.
 *
 * Routes through OpenClaw Gateway (/v1/chat/completions — OpenAI-compatible).
 * This gives us:
 *   - Centralized auth (gateway manages API keys)
 *   - Model access (gateway token has full model access, direct oat01 token doesn't)
 *   - Unified billing/monitoring through OpenClaw
 *
 * Fallback: direct Anthropic Messages API if gateway is unavailable.
 */

import type { LlmCompletionRequest, LlmCompletionResponse, LlmContent } from "./types";

// ─── Gateway config ───────────────────────────────────────────────────────────

const GATEWAY_ENDPOINT = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18790";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

// Fallback: direct Anthropic API
const ANTHROPIC_ENDPOINT = process.env.ANTHROPIC_ENDPOINT || "https://api.anthropic.com/v1";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const REQUEST_TIMEOUT_MS = 120_000; // 2min — large screenshots (400KB+) can take longer via gateway
const MAX_RETRIES = 2;

export class LlmClient {
  private readonly gatewayUrl: string;
  private readonly gatewayToken: string;
  private readonly anthropicUrl: string;
  private readonly anthropicKey: string;
  private useGateway: boolean;

  constructor() {
    this.gatewayUrl = GATEWAY_ENDPOINT;
    this.gatewayToken = GATEWAY_TOKEN;
    this.anthropicUrl = ANTHROPIC_ENDPOINT;
    this.anthropicKey = ANTHROPIC_API_KEY;

    // Prefer gateway if token is available
    this.useGateway = !!this.gatewayToken;

    if (!this.gatewayToken && !this.anthropicKey) {
      console.warn("[llm-client] No OPENCLAW_GATEWAY_TOKEN or ANTHROPIC_API_KEY set — agent LLM calls will fail");
    }

    console.log(`[llm-client] Mode: ${this.useGateway ? "gateway" : "direct-anthropic"}`);
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (this.useGateway) {
      try {
        return await this.completeViaGateway(req);
      } catch (err) {
        console.warn(`[llm-client] Gateway failed: ${(err as Error).message}, trying direct Anthropic`);
        if (this.anthropicKey) {
          return await this.completeViaAnthropic(req);
        }
        throw err;
      }
    }
    return await this.completeViaAnthropic(req);
  }

  // ─── Gateway path (OpenAI-compatible) ─────────────────────────────────────

  private async completeViaGateway(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // Convert to OpenAI chat format
    const messages: Array<Record<string, unknown>> = [];

    // System message
    if (req.systemPrompt) {
      messages.push({ role: "system", content: req.systemPrompt });
    }

    // User message with potential images
    const userContent: Array<Record<string, unknown>> = [];
    for (const c of req.userContent) {
      if (c.type === "text") {
        userContent.push({ type: "text", text: c.text });
      } else {
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:${c.mediaType || "image/jpeg"};base64,${c.base64}`,
          },
        });
      }
    }
    messages.push({ role: "user", content: userContent });

    // Model name: gateway expects "anthropic/model-name" format
    const model = req.model.includes("/") ? req.model : `anthropic/${req.model}`;

    const body = {
      model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      messages,
    };

    const resp = await this.fetchWithRetry(
      `${this.gatewayUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.gatewayToken}`,
        },
        body: JSON.stringify(body),
      },
    );

    const data = await resp.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };

    const text = data.choices?.[0]?.message?.content ?? "";

    return {
      text,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      model: data.model ?? req.model,
    };
  }

  // ─── Direct Anthropic path (fallback) ─────────────────────────────────────

  private async completeViaAnthropic(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // Strip "anthropic/" prefix for direct API — gateway uses "anthropic/model" but Anthropic API expects just "model"
    const anthropicModel = req.model.startsWith("anthropic/")
      ? req.model.replace("anthropic/", "")
      : req.model;

    const content = req.userContent.map((c) => {
      if (c.type === "text") {
        return { type: "text" as const, text: c.text };
      }
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: (c.mediaType || "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: c.base64,
        },
      };
    });

    const body = {
      model: anthropicModel,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.systemPrompt,
      messages: [{ role: "user", content }],
    };

    const resp = await this.fetchWithRetry(
      `${this.anthropicUrl}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
    );

    const data = await resp.json() as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };

    const text = data.content
      .filter((c: { type: string; text?: string }) => c.type === "text" && c.text)
      .map((c: { type: string; text?: string }) => c.text!)
      .join("");

    return {
      text,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      model: data.model,
    };
  }

  // ─── Shared fetch with timeout + retry ────────────────────────────────────

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let resp: Response;
      try {
        resp = await fetch(url, { ...init, signal: controller.signal });
      } catch (err) {
        clearTimeout(timeoutId);
        if ((err as Error).name === "AbortError") {
          throw new Error(`LLM API timeout after ${REQUEST_TIMEOUT_MS / 1000}s`);
        }
        lastError = err as Error;
        if (attempt < MAX_RETRIES) {
          const delay = 1000 * Math.pow(2, attempt);
          console.warn(`[llm-client] Network error on attempt ${attempt + 1}, retrying in ${delay}ms: ${lastError.message}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw lastError;
      }

      clearTimeout(timeoutId);

      // Retry on 429 or 5xx
      if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[llm-client] ${resp.status} on attempt ${attempt + 1}, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "unknown");
        throw new Error(`LLM API error ${resp.status}: ${errText}`);
      }

      return resp;
    }

    throw lastError ?? new Error("LLM API: all retries exhausted");
  }
}

// Singleton
let _instance: LlmClient | null = null;
export function getLlmClient(): LlmClient {
  if (!_instance) {
    _instance = new LlmClient();
  }
  return _instance;
}
