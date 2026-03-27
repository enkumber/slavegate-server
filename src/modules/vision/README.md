# vision — Phase 3

VLM provider routing, prompt construction, token economy, vision_config management.

## What goes here

- `vision.service.ts` — main entry: receives `vision_request` from device, routes to provider
- `providers/google.ts` — Gemini 2.0 Flash integration
- `providers/openai.ts` — GPT-4o-mini integration
- `providers/local.ts` — Local Qwen3-VL-8B (Jetson/GPU endpoint)
- `prompt-templates.ts` — standardized prompts per requestType
- `normalizer.ts` — normalize VLM output → ScreenElement[]

## Flow

```
device VISION_REQUEST
  → ws.server.ts → vision.service.ts
  → resize check (server-side if needed)
  → route to configured provider (vision_config table)
  → VLM response → normalize → ScreenElement[]
  → log to vlm_usage_log
  → VISION_RESULT → device
```

## Provider interface

```typescript
interface VlmProvider {
  query(screenshot: Buffer, prompt: string, maxTokens: number): Promise<VlmResponse>;
}

interface VlmResponse {
  elements: ScreenElement[];
  sceneDescription: string;
  detectedState?: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}
```

## Token economy

- Screenshot resized to max 1280px wide (device should do this before sending)
- JPEG quality 80% (set by device capture module)
- Max tokens: 512 (configurable in vision_config)
- Temperature: 0.1 (deterministic output preferred)
- Fallback provider: if primary fails or times out → automatic retry on fallback

## Config (runtime, from DB)

```sql
SELECT * FROM vision_config WHERE id = 'default';
-- Update via: POST /api/vision/config
```
