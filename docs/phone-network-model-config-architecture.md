# Phone Network AI Model Config Architecture

## Decision
Build a server-side AI Model Config layer with two runtime roles:

- `decision_llm` — text/planning/comment generation.
- `vision_vlm` — screenshot/image reasoning.

Flow remains: `phone -> server -> provider/GX10 -> server -> phone`.

Devices never receive provider endpoints with secrets or raw API keys. DirectWS semantics stay unchanged: devices send `LLM_REQUEST`; server returns `LLM_RESULT`.

Preferred defaults should be GX10/OpenAI-compatible, not Google/Gemini:

- `vision_vlm`: `openai_compatible` -> GX10 vLLM/Gemma vision model.
- `decision_llm`: separate OpenAI-compatible text model, GX10-capable.

## Current findings / warnings

1. Existing DB default still points to Google:
   - `vision_config.provider = google`
   - `api_key_ref = vault:vision/google_api_key`
   - This causes the current runtime failure.

2. Env override edits in `vision.service.ts` are only acceptable as temporary compatibility.
   - DB/dashboard config should be primary.
   - Env should be limited to bootstrap/fallback or explicit `env:` credential refs.

3. `/api/vision/config` accepting `apiKeyRef` is insufficient alone.
   - It risks plaintext/config confusion.
   - Prefer a separate credential write path and always return masked credential metadata.

4. `src/utils/llm.ts` contains hardcoded provider defaults/credential material. Remove this and route through the new server-side model router.

5. Check/fix `visionService.logUsage()` vs `vlm_usage_log` schema mismatch before relying on telemetry.

## Data model

Add migration `031_ai_model_config.sql`.

### `ai_model_configs`

One active config per role.

```sql
CREATE TABLE IF NOT EXISTS ai_model_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('decision_llm', 'vision_vlm')),
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_ref TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  version_hash TEXT NOT NULL,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  health_error TEXT,
  health_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_model_active_role
ON ai_model_configs(role)
WHERE enabled = true;
```

### `ai_model_secrets`

Use existing AES-256-GCM helper pattern if available. Otherwise create `modules/ai/secret-store.ts`.

```sql
CREATE TABLE IF NOT EXISTS ai_model_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  last_four TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

If `CREDENTIAL_ENCRYPTION_KEY` is missing, block DB secret storage clearly and allow only `env:VAR_NAME` references.

## API endpoints

New dashboard/server endpoints:

```http
GET    /api/server/models
GET    /api/server/models/:role
PATCH  /api/server/models/:role
POST   /api/server/models/:role/credential
POST   /api/server/models/:role/test
```

Behavior:

- `GET` returns config with masked credential metadata:
  - `credentialConfigured: true`
  - `credentialRefType: ai-secret | env`
  - `lastFour`
  - never raw secret.
- `PATCH` updates provider/endpoint/model/params/enabled.
- `credential` stores encrypted secret or sets an `env:VAR` reference.
- `test` resolves config+credential, performs a tiny provider call/health check, stores health result, and returns redacted status.

Backward compatibility:

```http
GET   /api/vision/config
PATCH /api/vision/config
```

Keep them, mapping internally to `role = vision_vlm`.

## Runtime integration

Add:

- `src/modules/ai/model-config.service.ts`
- `src/modules/ai/secret-store.ts`
- `src/modules/ai/model-router.ts`
- `src/modules/ai/providers/openai-compatible.ts` or reuse existing provider code.

Routing rules:

- DirectWS `LLM_REQUEST`
  - if screenshot/image exists -> `vision_vlm`
  - otherwise -> `decision_llm`
  - response remains `LLM_RESULT { requestId, result, error? }`

- Vision APIs / `VisionService` use `vision_vlm`.
- `src/utils/llm.ts` uses `decision_llm`.

Typed failures before provider call:

- `AI_MODEL_CONFIG_MISSING`
- `AI_MODEL_DISABLED`
- `AI_CREDENTIAL_MISSING`
- `AI_PROVIDER_UNSUPPORTED`

Cache:

- Cache resolved config per role for 30–60s.
- Compute `version_hash` from provider/endpoint/model/params/credential_ref.
- Invalidate immediately after dashboard/API writes.

## Dashboard

Add `Server -> Tokens / Models` or a top-level `Models` route.

Models page:

- Decision LLM card/row.
- Vision VLM card/row.
- Fields: provider, endpoint, model, credential input, enabled toggle, params JSON/advanced section, version hash, updated at, health status/error.
- Button: `Test connection`.
- Never display stored API keys after save.

## GX10 deployment notes

Use `/data/.openclaw/credentials/gx10-vllm.json` only as local input/import source. Do not commit or expose it.

Recommended seed locally:

- Read GX10 endpoint/model/key from credential file or env.
- Store encrypted credential in `ai_model_secrets`, or use `env:` refs if encryption key is unavailable.
- Create/update:
  - `vision_vlm` -> GX10 Gemma VLM endpoint/model.
  - `decision_llm` -> GX10 text model endpoint/model.

Remove Google/Gemini as active runtime defaults.

## Test/build plan

Minimum gates:

```bash
npm run build
npm test
npm run db:migrate
```

Manual/API checks:

- `GET /api/server/models`
- save `decision_llm`
- save `vision_vlm`
- credential save returns masked metadata only
- test connection succeeds/fails clearly
- `PATCH /api/vision/config` still updates `vision_vlm`
- DirectWS text-only `LLM_REQUEST` returns `LLM_RESULT`
- DirectWS screenshot `LLM_REQUEST` routes to `vision_vlm`
- logs/responses contain no raw keys

Security grep:

```bash
grep -R "google_api_key\|36fad768\|API_KEY" src dashboard-src
```

Review focus:

- no secrets in responses/logs/git
- role routing correctness
- dashboard cannot leak stored credentials
- failure messages are useful but not secret-bearing
