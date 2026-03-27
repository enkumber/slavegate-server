# accounts — Phase 3

Account management system: credential vault, device binding, lifecycle (warmup → active → cooldown), ban detection.

## What goes here

- `accounts.service.ts` — CRUD, device binding, lifecycle state machine
- `credential-vault.ts` — AES-256-GCM encryption/decryption of credentials
- `lifecycle.ts` — warmup scheduler, ban detection rules

## Schema additions (Phase 3 migration)

See `ARCHITECTURE_AUDIT.md` section 4.3 for full `accounts` table schema.

## Security notes

- Credentials NEVER stored plain. AES-256-GCM, key from environment (not hardcoded).
- Decryption only happens server-side when job needs it; never stored decrypted in DB.
- Session tokens (cookies) stored encrypted per account-device pair.
