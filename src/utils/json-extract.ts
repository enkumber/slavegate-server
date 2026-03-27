/**
 * utils/json-extract.ts
 * Robust JSON extraction from LLM responses.
 * Handles: raw JSON, ```json fences, embedded JSON in text.
 */

export function extractJson<T>(text: string): T | null {
  // 1. Direct parse
  try { return JSON.parse(text); } catch {}

  // 2. ```json ... ``` fenced blocks
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  // 3. First { ... } block — bracket-matching (handles nested objects correctly)
  const extracted = extractOutermostObject(text);
  if (extracted) {
    try { return JSON.parse(extracted); } catch {}
  }

  return null;
}

function extractOutermostObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
