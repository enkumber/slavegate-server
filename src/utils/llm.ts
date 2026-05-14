/**
 * LLM utilities for text generation tasks.
 * Runtime configuration is resolved server-side from model_configs role
 * `decision_llm`. Secrets are never hardcoded or sent to devices.
 */

import { modelConfigService } from "../modules/model-config/model-config.service";

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
  options?: { max_tokens?: number; system?: string }
): Promise<string> {
  const config = await modelConfigService.resolve("decision_llm");
  const maxTokens = options?.max_tokens ?? 2048;
  const messages: Array<{ role: string; content: string }> = [];
  if (options?.system) messages.push({ role: "system", content: options.system });
  messages.push({ role: "user", content: prompt });

  const provider = config.provider.toLowerCase();
  const selectedModel = model || config.model;

  if (provider === "anthropic") {
    const response = await fetch(`${endpointBase(config.endpoint, provider)}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        max_tokens: maxTokens,
      }),
    });
    if (!response.ok) throw new Error(`LLM API error (${response.status}): ${sanitizeProviderError(await response.text())}`);
    const data = await response.json() as { content?: Array<{ text?: string }> };
    return data.content?.map((part) => part.text ?? "").join("") ?? "";
  }

  const url = `${endpointBase(config.endpoint, provider)}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider === "minimax") headers["x-api-key"] = config.apiKey;
  else headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: selectedModel,
      messages,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${sanitizeProviderError(errText)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    content?: Array<{ text?: string }>;
  };

  return (
    data.choices?.[0]?.message?.content ||
    data.content?.[0]?.text ||
    ""
  );
}

function sanitizeProviderError(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|authorization|x-api-key)([\"'\s:=]+)([^\"'\s,}]+)/gi, "$1$2[redacted]")
    .slice(0, 500);
}

function endpointBase(endpoint: string | null, provider: string): string {
  const fallback = provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
  return (endpoint || fallback).replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * JSON completion with parsing.
 * Extracts JSON from response even if wrapped in markdown.
 */
export async function llmJson<T = unknown>(
  prompt: string,
  model?: string,
  options?: { max_tokens?: number; system?: string }
): Promise<T> {
  const response = await llmComplete(prompt, model, options);

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

// ═══════════════════════════════════════════════════════════════════════════════
// DOMAIN-SPECIFIC GENERATORS
// ═══════════════════════════════════════════════════════════════════════════════

export async function generateHashtags(
  interests: string[],
  locations: string[] = [],
  count: number = 15
): Promise<string[]> {
  const interestsStr = interests.length > 0 ? interests.join(", ") : "general content";
  const locationsStr = locations.length > 0 ? locations.join(", ") : "global";

  const prompt = `Generate exactly ${count} Instagram hashtags for this niche:

Industry/Interests: ${interestsStr}
Target locations: ${locationsStr}

Requirements:
- Mix of high-volume hashtags (100K+ posts) and niche-specific ones
- Include location-specific variants if locations are specified (e.g., #modelromania)
- NO generic hashtags like #love #instagood #photooftheday
- Focus on hashtags that attract engaged followers, not just views
- Include hashtags at different popularity levels for optimal reach

Return ONLY a JSON array of hashtag names WITHOUT the # symbol.
Example: ["onlyfansmodel", "fanslymodel", "romanianmodel", "boudoirphotography"]`;

  try {
    const hashtags = await llmJson<string[]>(prompt);
    return hashtags
      .filter((h) => typeof h === "string" && h.length > 0)
      .map((h) => `#${h.replace(/^#/, "").toLowerCase().replace(/\s+/g, "")}`)
      .slice(0, count);
  } catch (err) {
    console.error("[llm] Hashtag generation failed:", (err as Error).message);
    console.warn("[llm] Using interest-based fallback hashtags");
    return interests
      .slice(0, count)
      .map((i) => `#${i.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "")}`);
  }
}

export async function generateContentIdeas(
  niche: string,
  contentTypes: string[] = ["photos", "reels"],
  count: number = 5
): Promise<string[]> {
  const prompt = `Generate ${count} content ideas for Instagram in this niche: ${niche}

Content types to focus on: ${contentTypes.join(", ")}

Requirements:
- Specific, actionable ideas (not vague concepts)
- Mix of trending formats and evergreen content
- Include hook/caption ideas where relevant

Return ONLY a JSON array of content idea strings.`;

  try {
    return await llmJson<string[]>(prompt);
  } catch (err) {
    console.error("[llm] Content ideas generation failed:", (err as Error).message);
    throw err;
  }
}
