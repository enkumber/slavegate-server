/**
 * utils/llm.ts
 * LLM utilities for text generation tasks.
 *
 * Configurable via env vars:
 *   LLM_BASE_URL  — OpenAI-compatible endpoint (default: Qwen on GX10)
 *   LLM_API_KEY   — API key for the endpoint
 *   LLM_MODEL     — Model name (default: Qwen/Qwen3.5-122B-A10B)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// LLM CLIENT CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://enkzoned.go.ro:12321/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY || "36fad768f6d47ec7da413f201360bb19689f4f8aa@!0347cecc";
const LLM_MODEL = process.env.LLM_MODEL || "Qwen/Qwen3.5-122B-A10B";

// ═══════════════════════════════════════════════════════════════════════════════
// CORE LLM FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple text completion via OpenClaw Gateway.
 * Returns the raw text response.
 */
export async function llmComplete(
  prompt: string,
  model = "Qwen/Qwen3.5-122B-A10B",
  options?: { max_tokens?: number; system?: string }
): Promise<string> {
  const maxTokens = options?.max_tokens ?? 2048;

  const messages: Array<{ role: string; content: string }> = [];
  if (options?.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: prompt });

  const response = await fetch(LLM_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || LLM_MODEL,
      messages,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errText}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    content?: Array<{ text?: string }>;
  };

  // Support both OpenAI-style and Anthropic-style response formats
  return (
    data.choices?.[0]?.message?.content ||
    data.content?.[0]?.text ||
    ""
  );
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

  // Try to extract JSON from response
  let jsonStr = response.trim();

  // Remove markdown code blocks if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Extract valid JSON using brace/bracket counting (handles nested structures)
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
  if (extracted) {
    jsonStr = extracted;
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch (err) {
    // Retry: strip trailing commas (common LLM mistake)
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

/**
 * Generate hashtags for a niche/industry.
 * Returns array of hashtags with # prefix.
 */
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
    const hashtags = await llmJson<string[]>(prompt, "Qwen/Qwen3.5-122B-A10B");

    // Validate and normalize
    return hashtags
      .filter((h) => typeof h === "string" && h.length > 0)
      .map((h) => `#${h.replace(/^#/, "").toLowerCase().replace(/\s+/g, "")}`)
      .slice(0, count);
  } catch (err) {
    console.error("[llm] Hashtag generation failed:", (err as Error).message);

    // Fallback: generate basic hashtags from interests
    console.warn("[llm] Using interest-based fallback hashtags");
    return interests
      .slice(0, count)
      .map((i) => `#${i.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "")}`);
  }
}

/**
 * Generate content ideas for a niche.
 */
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
