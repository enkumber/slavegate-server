/**
 * vision/vision.service.ts
 * VLM provider routing and request handling.
 *
 * Responsibilities:
 * - Load vision_config from DB (provider, model, api_key_ref, endpoint)
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
  provider:     "anthropic" | "openai_compatible" | "minimax";
  model:        string;
  endpoint:     string | null;
  apiKeyRef:    string;   // Vault reference or direct env var name
  maxTokens:    number;
  temperature:  number;
  timeoutMs:    number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class VisionService {
  private cachedProvider: VisionProvider | null = null;
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
    const apiKey = resolveApiKeyRef(config.apiKeyRef);

    let provider: VisionProvider;
    switch (config.provider) {
      case "anthropic":
        provider = new AnthropicVisionProvider({
          apiKey,
          model:       config.model,
          endpoint:    config.endpoint ?? undefined,
          maxTokens:   config.maxTokens,
          temperature: config.temperature,
          timeoutMs:   config.timeoutMs,
        });
        break;
      case "openai_compatible":
        provider = new OpenAICompatibleProvider({
          apiKey,
          model:       config.model,
          endpoint:    config.endpoint ?? undefined,
          maxTokens:   config.maxTokens,
          temperature: config.temperature,
          timeoutMs:   config.timeoutMs,
        });
        break;
      case "minimax":
        provider = new MiniMaxVisionProvider({
          apiKey:     apiKey,
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
    this.configCachedAt = now;
    console.log(`[vision] Provider loaded: ${provider.name} model=${config.model}`);
    return provider;
  }

  private async loadConfig(): Promise<VisionConfig> {
    const db = getDb();
    const row = await db.query(
      "SELECT * FROM vision_config WHERE id = 'default' LIMIT 1"
    );
    if (row.rows.length === 0) {
      throw new Error("vision_config table has no 'default' row. Run schema migration.");
    }
    const r = row.rows[0] as Record<string, unknown>;
    return {
      provider:    (r.provider as string) as VisionConfig["provider"],
      model:       r.model as string,
      endpoint:    (r.endpoint as string) ?? null,
      apiKeyRef:   r.api_key_ref as string,
      maxTokens:   (r.max_tokens as number) ?? 512,
      temperature: (r.temperature as number) ?? 0.1,
      timeoutMs:   (r.timeout_ms as number) ?? 15_000,
    };
  }

  /** Force provider reload — call after updating vision_config */
  invalidateCache(): void {
    this.cachedProvider = null;
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
  }): Promise<void> {
    try {
      const db = getDb();
      await db.query(
        `INSERT INTO vlm_usage_log
           (device_id, workflow_id, job_id, request_type, action_type, tokens_used, latency_ms, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [log.deviceId, log.workflowId, log.jobId, log.requestType, log.actionType, log.tokensUsed, log.latencyMs, log.provider]
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

// ─── API key resolution ───────────────────────────────────────────────────────

/**
 * Resolve API key from Vault reference or env var.
 * Format:
 *   "vault:path/to/secret"  → Vault lookup (Phase 4: real HashiCorp Vault)
 *   "env:VAR_NAME"          → process.env[VAR_NAME]
 *   Direct string           → used as-is (dev only)
 */
function resolveApiKeyRef(ref: string): string {
  if (ref.startsWith("env:")) {
    const varName = ref.slice(4);
    const val = process.env[varName];
    if (!val) throw new Error(`API key env var not set: ${varName}`);
    return val;
  }
  if (ref.startsWith("vault:")) {
    // Phase 4: HashiCorp Vault lookup
    // For now: fall through to env var with normalized name
    const path    = ref.slice(6).replace(/\//g, "_").toUpperCase();
    const val     = process.env[path];
    if (!val) throw new Error(`Vault secret not available in dev mode: ${ref}. Set env var: ${path}`);
    return val;
  }
  // Direct value (dev/test only)
  return ref;
}

export const visionService = new VisionService();
