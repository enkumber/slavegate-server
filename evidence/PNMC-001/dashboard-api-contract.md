# PNMC-001 Dashboard/API Contract Evidence

HEAD under test: `8bcb03628d30710f088caa361a52eb3bef200e76` plus local PNMC dashboard evidence changes.

## Dashboard coverage

- `decision_llm` and `vision_vlm` render as separate editable model cards inside Tokens & Models.
- Each card edits provider, endpoint, model, and enabled state through `PATCH /api/server/models/:role`.
- Credential mutation is explicit and separate from metadata saves:
  - retain stored credential: no credential endpoint call
  - replace with pasted secret: `POST /api/server/models/:role/credential` with `{ credential }`
  - use server ref: `POST /api/server/models/:role/credential` with `{ credentialRef }`
  - clear credential: `POST /api/server/models/:role/credential` with `{ credentialRef: null }`
- Drafts are created from redacted API metadata only. Stored secret and stored ref values are not rehydrated into inputs.
- Disabled, missing-config, missing-credential, test-ok, and test-error states have visible card status text.
- Connection tests call `POST /api/server/models/:role/test`; failures reload redacted state and surface the actionable server error.

## Static redaction guard

`tests/pnmc-001/model-config-dashboard-contract.test.ts` verifies:

- dashboard drafts start with blank credential/ref fields from redacted API responses
- metadata patches do not carry credential material
- retain/replace/reference/clear credential requests are deterministic
- API payloads containing `apiKey`, `credentialRef`, `apiKeyEncrypted`, or unredacted `credential` are rejected by the typed dashboard boundary
- `TokenManagement.tsx` does not directly render raw secret-bearing fields such as `apiKeyEncrypted`, `apiKeyFingerprint`, `credentialRefType`, or `config.credential`

## Contract note for FORGE/VOLT

Dashboard code expects the server list/update/test responses for `/api/server/models` and `/api/model-configs` to remain redacted. Safe metadata may include:

- `role`, `provider`, `endpoint`, `model`, `enabled`, `version`, `updatedAt`
- `credential` only as `redacted` or `null`
- `credentialConfigured`/`hasCredential`, `credentialRefType`, `apiKeyFingerprint`/`lastFour`
- `lastTestStatus`, `lastTestMessage`, `lastTestAt`, `versionHash`

Server responses must not include raw `apiKey`, `api_key`, `credentialRef`, `credential_ref`, `apiKeyEncrypted`, or `api_key_encrypted`.
