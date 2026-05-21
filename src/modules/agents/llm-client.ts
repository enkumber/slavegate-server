/**
 * agents/llm-client.ts
 * Shared LLM client for multi-agent architecture.
 *
 * Routes through OpenClaw Gateway (/v1/chat/completions — OpenAI-compatible).
 * This gives us:
 *   - Centralized auth (gateway manages API keys)
 *   - Model access (gateway token has full model access, direct oat01 token doesn't)
 *   - Unified billing/monitoring through OpenClaw
 */

import type { LlmCompletionRequest, LlmCompletionResponse, LlmContent } from "./types";

// ─── Gateway config ───────────────────────────────────────────────────────────

const GATEWAY_ENDPOINT = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18790";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

// Local Ollama is optional for explicitly enabled local vision/planning routes.
const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://192.168.50.185:11434";
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "llava:34b";
const OLLAMA_PLANNING_MODEL = process.env.OLLAMA_PLANNING_MODEL || "qwen3:14b";
const USE_LOCAL_VISION = process.env.USE_LOCAL_VISION === "true"; // default: false
const USE_LOCAL_PLANNING = process.env.USE_LOCAL_PLANNING === "true"; // default: false

const REQUEST_TIMEOUT_MS = 120_000; // 2min — large screenshots (400KB+) can take longer via gateway
const MAX_RETRIES = 2;

export class LlmClient {
  private readonly gatewayUrl: string;
  private readonly gatewayToken: string;

  constructor() {
    this.gatewayUrl = GATEWAY_ENDPOINT;
    this.gatewayToken = GATEWAY_TOKEN;

    if (!this.gatewayToken) {
      console.warn("[llm-client] No OPENCLAW_GATEWAY_TOKEN set — agent LLM calls will fail");
    }

    console.log("[llm-client] Mode: gateway");
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // Route ONLY simple vision requests to Ollama (not planning which needs JSON)
    // Planning prompts mention "JSON" or "steps" and need structured output.
    const hasImages = req.userContent.some(c => c.type === "image");
    const needsStructuredOutput = req.systemPrompt?.toLowerCase().includes("json") || 
                                   req.systemPrompt?.toLowerCase().includes("steps") ||
                                   req.userContent.some(c => c.type === "text" && c.text.toLowerCase().includes("json"));
    
    // Force Ollama for llava model or simple vision requests
    const forceOllamaVision = req.model.startsWith("llava");
    
    console.log(`[llm-client] hasImages=${hasImages}, needsStructuredOutput=${needsStructuredOutput}, forceOllamaVision=${forceOllamaVision}`);
    
    // Route vision requests to Ollama LLaVA
    if (forceOllamaVision || (hasImages && USE_LOCAL_VISION && !needsStructuredOutput)) {
      console.log("[llm-client] Vision request → using local Ollama LLaVA");
      return await this.completeViaOllama(req);
    }
    
    // Route text-only planning (JSON) to Ollama Qwen3 for speed and reliability
    if (!hasImages && needsStructuredOutput && USE_LOCAL_PLANNING) {
      console.log("[llm-client] Planning request → using local Ollama Qwen3");
      return await this.completeViaOllamaPlanning(req);
    }

    return await this.completeViaGateway(req);
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
        // Image content
        const imageData = (c as { base64?: string }).base64;
        const mediaType = (c as { mediaType?: string }).mediaType || "image/jpeg";
        if (!imageData) {
          console.warn(`[llm-client] Image content has no base64 data:`, JSON.stringify(c).slice(0, 200));
          continue;
        }
        console.log(`[llm-client] Adding image: ${(imageData.length / 1024).toFixed(0)}KB, type=${mediaType}`);
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:${mediaType};base64,${imageData}`,
          },
        });
      }
    }
    messages.push({ role: "user", content: userContent });

    const model = req.model || "openai-codex/gpt-5.5";

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

  // ─── Local Ollama path (planning via Qwen3) ─────────────────────────────────

  private async completeViaOllamaPlanning(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const textParts: string[] = [];
    for (const c of req.userContent) {
      if (c.type === "text") {
        textParts.push(c.text);
      }
    }
    const prompt = textParts.join("\n");

    console.log(`[llm-client] Ollama planning with ${OLLAMA_PLANNING_MODEL}`);

    const body = {
      model: OLLAMA_PLANNING_MODEL,
      messages: [
        ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
        { role: "user", content: prompt },
      ],
      stream: false,
      options: {
        temperature: req.temperature ?? 0.3,
        num_predict: req.maxTokens ?? 4000,
      },
    };

    const resp = await this.fetchWithRetry(
      `${OLLAMA_ENDPOINT}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const data = await resp.json() as {
      message?: { content: string; thinking?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      model?: string;
    };

    // Qwen3.5 might put JSON in thinking field, handle both cases
    let text = data.message?.content ?? "";
    if (!text && data.message?.thinking) {
      // Extract JSON from thinking if content is empty
      const thinkingMatch = data.message.thinking.match(/\{[\s\S]*\}/);
      if (thinkingMatch) {
        text = thinkingMatch[0];
      }
    }

    return {
      text,
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      model: data.model ?? OLLAMA_PLANNING_MODEL,
    };
  }

  // ─── Local Ollama path (vision via LLaVA) ──────────────────────────────────

  private async completeViaOllama(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // Extract text and images
    const textParts: string[] = [];
    const images: string[] = [];

    for (const c of req.userContent) {
      if (c.type === "text") {
        textParts.push(c.text);
      } else if (c.type === "image" && c.base64) {
        images.push(c.base64);
        console.log(`[llm-client] Ollama image: ${(c.base64.length / 1024).toFixed(0)}KB`);
      }
    }

    const prompt = textParts.join("\n");

    const body = {
      model: OLLAMA_VISION_MODEL,
      messages: [
        ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
        {
          role: "user",
          content: prompt + " /no_think", // Disable thinking mode for speed/memory
          images: images,
        },
      ],
      stream: false,
      options: {
        temperature: req.temperature ?? 0.7,
        num_ctx: 4096, // Limit context to save VRAM
      },
    };

    const resp = await this.fetchWithRetry(
      `${OLLAMA_ENDPOINT}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const data = await resp.json() as {
      message?: { content: string; thinking?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      model?: string;
    };

    // Qwen3.5 might put response in thinking field when content is empty
    let text = data.message?.content ?? "";
    if (!text && data.message?.thinking) {
      text = data.message.thinking;
    }

    return {
      text,
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      model: data.model ?? OLLAMA_VISION_MODEL,
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
