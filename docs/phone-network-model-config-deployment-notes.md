# Phone Network Model Config Deployment Notes

No provider secrets belong in GitHub, Docker build logs, dashboard responses, or phone payloads.

## Deploy

1. Push server changes after review.
2. Build and publish the server Docker image from this repo.
3. Bump the Umbrel app/image tag to the new server image.
4. Deploy/restart the Umbrel app so startup migrations create `model_configs`.
5. Confirm `GET /api/model-configs` returns redacted `decision_llm` and `vision_vlm` rows.

## Local secret/config seeding

Use dashboard `#/models` or the authenticated API to configure both roles. Prefer `/api/server/models*` endpoints. Without `CREDENTIAL_ENCRYPTION_KEY`, DB secret writes are blocked and only `credentialRef=env:VAR_NAME` is accepted. With `CREDENTIAL_ENCRYPTION_KEY`, you may use encrypted DB credentials or server-local refs such as `file:/data/.openclaw/credentials/gx10-vllm.json`. Do not paste or print the contents of the GX10 credential file in logs or tickets.

Minimum fields per role:

- `provider`: usually `openai_compatible` for GX10/vLLM.
- `endpoint`: OpenAI-compatible base URL (`.../v1`) or full `.../v1/chat/completions`.
- `model`: provider model name.
- `enabled`: `true` only after credential is present.
- `credential`: write via `POST /api/server/models/:role/credential`; stored AES-256-GCM only when `CREDENTIAL_ENCRYPTION_KEY` is set.
- `credentialRef`: use `env:VAR_NAME` when no encryption key is configured; API responses are redacted.

## Checks after deploy

- `POST /api/server/models/decision_llm/test` returns OK or a clear provider error.
- `POST /api/server/models/vision_vlm/test` returns OK or a clear provider error.
- `GET /api/vision/config` works for legacy callers and does not expose raw secrets.
- DirectWS text-only `LLM_REQUEST` returns `LLM_RESULT` via `decision_llm`.
- DirectWS screenshot `LLM_REQUEST` returns `LLM_RESULT` via `vision_vlm`.
