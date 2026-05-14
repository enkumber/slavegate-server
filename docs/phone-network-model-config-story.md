# Story: Server-side Model & Token Configuration

## Goal
Replace ad-hoc `vision_config`/environment-only LLM/VLM behavior with DB-backed, dashboard-managed server-side model configuration for Phone Network.

## Why now
`reddit_karma_farm` reaches the edge workflow run loop and sends `LLM_REQUEST`, but the live server currently fails with missing Google vision credentials. Dan does not want Google Vision. Phones must call the server, and the server must call configured providers/GX10 without exposing credentials to devices.

## Product requirements
1. Dashboard server tab for `Tokens` / `Models` configuration.
2. Persist provider/model/credential config in Postgres, not GitHub.
3. Keep secrets server-side. Do not send raw API keys to phones. Do not commit secrets.
4. Support at least two logical roles:
   - `decision_llm`
   - `vision_vlm`
5. Each role config stores provider, endpoint, model, credential/API key, enabled flag, version/hash, timestamps, and health/test status.
6. Add API and dashboard button to test a connection.
7. Runtime routes LLM/VLM calls by role.
8. Cache config briefly and invalidate after updates.
9. Fail clearly when required config/credentials are missing; no silent empty analysis loops.
10. Preserve edge workflow path and DirectWS `LLM_REQUEST`/`LLM_RESULT` semantics.
11. Add DB migration and API endpoints. Keep `/api/vision/config` backward compatible where practical.

## Implementation notes
- Existing quick edits in `src/modules/vision/vision.service.ts` and `src/api/routes.ts` should be reviewed/reworked, not blindly accepted.
- Existing `vision_config` default points at Google (`vault:vision/google_api_key`); new implementation should supersede this with role-based model config while maintaining read/write compatibility for old callers.
- GX10 credential exists locally at `/data/.openclaw/credentials/gx10-vllm.json`; do not print, expose, or commit its secret.
- If existing encryption helpers are found, use them. If not, store credential material in DB only as an incremental local-admin solution, redact it from APIs, include credential fingerprint/version, and document encryption-at-rest as follow-up.

## Suggested data model
Create `model_configs`:
- `role TEXT PRIMARY KEY CHECK(role IN ('decision_llm','vision_vlm'))`
- `provider TEXT NOT NULL`
- `endpoint TEXT`
- `model TEXT NOT NULL`
- `api_key_encrypted TEXT` or `credential_ref TEXT` / `api_key_ciphertext TEXT` depending on available helpers
- `api_key_fingerprint TEXT`
- `enabled BOOLEAN NOT NULL DEFAULT true`
- `version INT NOT NULL DEFAULT 1`
- `last_test_status TEXT`
- `last_test_message TEXT`
- `last_test_at TIMESTAMPTZ`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Seed sensible disabled/default rows or migrate old `vision_config` into `vision_vlm` without preserving the Google credential as an active default if it would keep failing.

## API sketch
- `GET /api/model-configs` returns redacted configs.
- `GET /api/model-configs/:role` returns one redacted config.
- `PUT/PATCH /api/model-configs/:role` validates provider/model/endpoint/enabled and updates credential only when supplied.
- `POST /api/model-configs/:role/test` resolves credential server-side, calls provider health endpoint/minimal completion, stores health result, and returns redacted status.
- Back compat:
  - `GET /api/vision/config` maps to `vision_vlm` config.
  - `PATCH /api/vision/config` updates `vision_vlm` fields and invalidates cache.

## Runtime sketch
- Add a shared model config service for role lookup, redaction, credential resolution, short TTL cache, invalidation, and test connection.
- Update `VisionService` to load `vision_vlm` via role service; throw actionable errors if missing/disabled/no credential.
- Update LLM utility/DirectWS LLM bridge to load `decision_llm` via role service and remove hardcoded provider credentials from source.
- Ensure DirectWS catches model config failures and replies with an `LLM_RESULT` error preserving protocol semantics.

## Acceptance criteria
- Dashboard can view/update/test `decision_llm` and `vision_vlm` without revealing stored secrets.
- Missing config/credential fails with a clear API/runtime error.
- Phones never receive raw API keys.
- Existing `/api/vision/config` callers still work or get a documented compatible response.
- `npm run build` passes; targeted tests pass if feasible.
- Deployment notes include server push, Docker build, Umbrel image bump, and local secret/config seeding without GitHub secrets.
