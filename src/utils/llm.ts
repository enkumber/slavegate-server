/**
 * LLM utilities for text generation tasks.
 * Runtime configuration is resolved server-side from model_configs role
 * `decision_llm`. Secrets are never hardcoded or sent to devices.
 */

import { modelConfigFetch, modelConfigService, sanitizeProviderError } from "../modules/model-config/model-config.service";

export interface LlmResponseMetadata {
  role: "decision_llm";
  provider: string;
  model: string;
  endpoint: string;
}

export interface LlmCompletionOptions {
  max_tokens?: number;
  system?: string;
  timeoutMs?: number;
  temperature?: number;
  disableThinking?: boolean;
  onRawResponse?: (response: string, metadata: LlmResponseMetadata) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE LLM FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple text completion via the configured decision_llm provider.
 * Returns the raw text response.
 */
export async function llmComplete(
  prompt: string,
  model?: string,
  options?: LlmCompletionOptions
): Promise<string> {
  const config = await modelConfigService.resolve("decision_llm");
  const maxTokens = options?.max_tokens ?? 2048;
  const provider = normalizeOpenAIProvider(config.provider);
  const selectedModel = model || config.model;
  const qwenNoThink = Boolean(
    options?.disableThinking &&
    provider !== "openai" &&
    selectedModel.toLowerCase().includes("qwen")
  );
  const noThinkPrefix = "/no_think\n";
  const messages: Array<{ role: string; content: string }> = [];
  if (options?.system) {
    messages.push({
      role: "system",
      content: qwenNoThink && !options.system.trimStart().startsWith("/no_think")
        ? `${noThinkPrefix}${options.system}`
        : options.system,
    });
  }
  messages.push({
    role: "user",
    content: qwenNoThink && !prompt.trimStart().startsWith("/no_think")
      ? `${noThinkPrefix}${prompt}`
      : prompt,
  });

  const url = `${endpointBase(config.endpoint, provider)}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${config.apiKey}`;
  const body: Record<string, unknown> = {
    model: selectedModel,
    messages,
    max_tokens: maxTokens,
  };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (qwenNoThink) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const response = await modelConfigFetch(url, {
    method: "POST",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(options?.timeoutMs ?? 30_000),
    body: JSON.stringify(body),
  }, "decision_llm");

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${sanitizeProviderError(errText)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    content?: Array<{ text?: string }>;
  };

  const content = (
    data.choices?.[0]?.message?.content ||
    data.content?.[0]?.text ||
    ""
  );
  options?.onRawResponse?.(content, {
    role: "decision_llm",
    provider: config.provider,
    model: selectedModel,
    endpoint: endpointBase(config.endpoint, provider),
  });
  return content;
}

function endpointBase(endpoint: string | null, provider: string): string {
  const fallback = "https://api.openai.com/v1";
  return (endpoint || fallback).replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

function normalizeOpenAIProvider(provider: string): string {
  const normalized = provider.toLowerCase();
  if (normalized === "openai" || normalized === "openai_compatible" || normalized === "openai-compatible") {
    return normalized;
  }
  throw new Error(`Unsupported LLM provider: ${provider}. Supported: openai, openai_compatible.`);
}

/**
 * JSON completion with parsing.
 * Extracts JSON from response even if wrapped in markdown.
 */
export async function llmJson<T = unknown>(
  prompt: string,
  model?: string,
  options?: LlmCompletionOptions
): Promise<T> {
  const response = await llmComplete(prompt, model, { ...options, disableThinking: options?.disableThinking ?? true });

  let jsonStr = response.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  function extractJson(str: string): string | null {
    const startChars = ['{', '['];
    const endChars = ['}', ']'];
    for (let i = 0; i < str.length; i++) {
      const startIdx = startChars.indexOf(str[i]);
      if (startIdx === -1) continue;
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < str.length; j++) {
        const c = str[j];
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === startChars[0] || c === startChars[1]) depth++;
        if (c === endChars[0] || c === endChars[1]) depth--;
        if (depth === 0) return str.slice(i, j + 1);
      }
    }
    return null;
  }

  const extracted = extractJson(jsonStr);
  if (extracted) jsonStr = extracted;

  try {
    return JSON.parse(jsonStr) as T;
  } catch (err) {
    try {
      const cleaned = jsonStr.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(cleaned) as T;
    } catch {
      console.error("[llm] Failed to parse JSON response:", response.slice(0, 500));
      throw new Error(`Failed to parse LLM JSON response: ${(err as Error).message}`);
    }
  }
}
