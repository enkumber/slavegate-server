/**
 * vision/vision.service.ts
 * VLM provider routing and request handling.
 *
 * Responsibilities:
 * - Load server-side vision_vlm model config from DB
 * - Instantiate correct provider adapter
 * - Resolve server-side prompt template (device sends requestType+actionType only)
 * - Call provider, normalize output
 * - Log token usage in vlm_usage_log
 * - Return structured VisionResult / VerifyResult to ws.server.ts
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §4.4
 */

import { getDb } from "../../db/client";
import { resolvePrompt, type RequestType } from "./templates/prompt-templates";
import { AnthropicVisionProvider } from "./providers/anthropic.provider";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.provider";
import { MiniMaxVisionProvider }    from "./providers/minimax.provider";
import type { VisionProvider, VisionResult, VerifyResult, VisionOptions } from "./vision-provider.interface";
import { modelConfigService } from "../model-config/model-config.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VisionRequest {
  jobId:             string;
  deviceId:          string;
  screenshotBase64:  string;
  requestType:       RequestType;
  actionType:        string;
  workflowId?:       string;
}

export interface VisionResponse {
  jobId:            string;
  requestType:      RequestType;
  elements:         VisionResult["elements"];
  sceneDescription: string;
  detectedState:    string | null;
  tokensUsed:       number;
  providerName:     string;
  latencyMs:        number;
}

export interface VerifyResponse {
  jobId:       string;
  success:     boolean;
  confidence:  number;
  observation: string;
  tokensUsed:  number;
  latencyMs:   number;
}

// ─── Vision config row ────────────────────────────────────────────────────────

interface VisionConfig {
  provider:     "anthropic" | "openai_compatible" | "openai" | "minimax";
  model:        string;
  endpoint:     string | null;
  apiKey:       string;
  maxTokens:    number;
  temperature:  number;
  timeoutMs:    number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class VisionService {
  private cachedProvider: VisionProvider | null = null;
  private cachedModel: string = "unknown";
  private configCachedAt: number = 0;
  private readonly CONFIG_TTL_MS = 60_000; // Re-read config every 60s

  /**
   * Handle VISION_REQUEST from device.
   * Resolves prompt server-side, calls VLM, returns structured result.
   */
  async handleVisionRequest(req: VisionRequest): Promise<VisionResponse> {
    const start    = Date.now();
    const provider = await this.getProvider();

    // Server-side prompt — device has no influence on prompt content
    const prompt = resolvePrompt({ requestType: req.requestType, actionType: req.actionType });

    const screenshotBuffer = Buffer.from(req.screenshotBase64, "base64");
    const result = await provider.analyze(screenshotBuffer, prompt);

    const latencyMs  = Date.now() - start;
    // Use real token count from provider API response; fall back to estimate only if unavailable
    const tokensUsed = result.tokensUsed ?? await this.estimateTokens(screenshotBuffer, prompt, result);

    await this.logUsage({
      deviceId:    req.deviceId,
      workflowId:  req.workflowId ?? null,
      jobId:       req.jobId,
      requestType: req.requestType,
      actionType:  req.actionType,
      tokensUsed,
      latencyMs,
      provider:    provider.name,
      model:       this.cachedModel,
    });

    return {
      jobId:            req.jobId,
      requestType:      req.requestType,
      elements:         result.elements,
      sceneDescription: result.sceneDescription,
      detectedState:    result.detectedState,
      tokensUsed,
      providerName:     provider.name,
      latencyMs,
    };
  }

  /**
   * Handle verification request (L3 of Verification Cascade).
   * Called by workflow executor when L1+L2 are inconclusive.
   */
  async handleVerifyRequest(
    deviceId:   string,
    jobId:      string,
    screenshotBase64: string,
    actionType: string,
    workflowId?: string
  ): Promise<VerifyResponse> {
    const start    = Date.now();
    const provider = await this.getProvider();

    const prompt = resolvePrompt({ requestType: "verify_action", actionType });
    const buf    = Buffer.from(screenshotBase64, "base64");

    const result = await provider.verify(buf, prompt);
    const latencyMs = Date.now() - start;

    await this.logUsage({
      deviceId,
      workflowId:  workflowId ?? null,
      jobId,
      requestType: "verify_action",
      actionType,
      tokensUsed:  result.tokensUsed,
      latencyMs,
      provider:    provider.name,
      model:       this.cachedModel,
    });

    return {
      jobId,
      success:     result.success,
      confidence:  result.confidence,
      observation: result.observation,
      tokensUsed:  result.tokensUsed,
      latencyMs,
    };
  }

  // ─── Provider loading ─────────────────────────────────────────────────────

  private async getProvider(): Promise<VisionProvider> {
    const now = Date.now();
    if (this.cachedProvider && now - this.configCachedAt < this.CONFIG_TTL_MS) {
      return this.cachedProvider;
    }

    const config = await this.loadConfig();

    let provider: VisionProvider;
    switch (config.provider) {
      case "anthropic":
        provider = new AnthropicVisionProvider({
          apiKey:      config.apiKey,
          model:       config.model,
          endpoint:    config.endpoint ?? undefined,
          maxTokens:   config.maxTokens,
          temperature: config.temperature,
          timeoutMs:   config.timeoutMs,
        });
        break;
      case "openai":
      case "openai_compatible":
        provider = new OpenAICompatibleProvider({
          apiKey:      config.apiKey,
          model:       config.model,
          endpoint:    config.endpoint ?? undefined,
          maxTokens:   config.maxTokens,
          temperature: config.temperature,
          timeoutMs:   config.timeoutMs,
        });
        break;
      case "minimax":
        provider = new MiniMaxVisionProvider({
          apiKey:     config.apiKey,
          model:      config.model,
          endpoint:   config.endpoint ?? "https://api.minimax.io/anthropic/v1",
          maxTokens:  config.maxTokens,
          temperature: config.temperature,
          timeoutMs:  config.timeoutMs,
        });
        break;
      default:
        throw new Error(`Unknown vision provider: ${config.provider}`);
    }

    this.cachedProvider = provider;
    this.cachedModel = config.model;
    this.configCachedAt = now;
    console.log(`[vision] Provider loaded: ${provider.name} model=${config.model}`);
    return provider;
  }

  private async loadConfig(): Promise<VisionConfig> {
    const r = await modelConfigService.resolve("vision_vlm");
    return {
      provider:    normalizeVisionProvider(r.provider),
      model:       r.model,
      endpoint:    normalizeEndpoint(r.endpoint),
      apiKey:      r.apiKey,
      maxTokens:   process.env.VISION_MAX_TOKENS ? Number(process.env.VISION_MAX_TOKENS) : 512,
      temperature: process.env.VISION_TEMPERATURE ? Number(process.env.VISION_TEMPERATURE) : 0.1,
      timeoutMs:   process.env.VISION_TIMEOUT_MS ? Number(process.env.VISION_TIMEOUT_MS) : 15_000,
    };
  }

  /** Force provider reload — call after updating model_configs/vision_vlm */
  invalidateCache(): void {
    this.cachedProvider = null;
    this.cachedModel = "unknown";
    this.configCachedAt = 0;
  }

  /**
   * Analyze screenshot with a custom prompt (for Smart-Path recovery).
   * Returns raw text response from VLM.
   */
  async analyzeCustomPrompt(
    screenshotBase64: string,
    prompt: string,
    options?: VisionOptions
  ): Promise<string> {
    const provider = await this.getProvider();
    const buffer = Buffer.from(screenshotBase64, "base64");
    const result = await provider.analyze(buffer, prompt, options);
    return result._rawResponse
      ? typeof result._rawResponse === "string"
        ? result._rawResponse as string
        : JSON.stringify(result._rawResponse)
      : JSON.stringify(result);
  }

  // ─── Token logging ────────────────────────────────────────────────────────

  private async logUsage(log: {
    deviceId:    string;
    workflowId:  string | null;
    jobId:       string;
    requestType: string;
    actionType:  string;
    tokensUsed:  number;
    latencyMs:   number;
    provider:    string;
    model:       string;
  }): Promise<void> {
    try {
      const db = getDb();
      await db.query(
        `INSERT INTO vlm_usage_log
           (device_id, workflow_id, job_id, request_type, provider, model, input_tokens, output_tokens, latency_ms, success)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, TRUE)`,
        [log.deviceId, log.workflowId, log.jobId, log.requestType, log.provider, log.model, log.tokensUsed, log.latencyMs]
      );
    } catch (err) {
      // Non-fatal — don't let logging failure break vision request
      console.error("[vision] Failed to log token usage:", (err as Error).message);
    }
  }

  // ─── Token estimation ─────────────────────────────────────────────────────

  /**
   * Estimate tokens if provider doesn't return usage info.
   * Anthropic returns usage in response; OpenAI-compatible also does.
   * This is a fallback for providers that don't.
   */
  private async estimateTokens(
    imageBuffer: Buffer,
    prompt:      string,
    result:      VisionResult
  ): Promise<number> {
    // Rough estimate: image ≈ 765 tokens (1280×720 JPEG) + prompt tokens + output tokens
    const imageTokens  = Math.round(imageBuffer.length / 500);  // Very rough
    const promptTokens = Math.round(prompt.length / 4);         // ~4 chars per token
    const outputTokens = Math.round(JSON.stringify(result).length / 4);
    return imageTokens + promptTokens + outputTokens;
  }
}

// ─── Provider normalization ──────────────────────────────────────────────────

function normalizeEndpoint(endpoint: string | null): string | null {
  return endpoint?.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") ?? null;
}

function normalizeVisionProvider(provider: string): VisionConfig["provider"] {
  const normalized = provider.toLowerCase();
  if (normalized === "openai") return "openai";
  if (normalized === "openai_compatible" || normalized === "openai-compatible") return "openai_compatible";
  if (normalized === "anthropic" || normalized === "minimax") return normalized;
  throw new Error(`Unsupported vision_vlm provider: ${provider}. Supported: openai_compatible, openai, anthropic, minimax.`);
}

export const visionService = new VisionService();
