# Gate 4 — exact DONE contract

Candidate baseline at contract creation:
`ff08a27eab689b8ca02075b8dc0d5370565ade7e`.

Gate 4 is DONE only when all evidence below is committed on one clean candidate
SHA and both ECHO and LENS issue a verdict on that exact SHA. A source-level
inventory is not execution proof.

## 1. Schema assumptions

- `schema-assumptions.json` contains every Gate 4 relation and its migration
  source, required shape, cardinality behavior and catalog probe.
- Against the disposable PostgreSQL 17 live-shape clone, capture
  `schema-catalog-proof.json` from `pg_catalog.pg_attribute`,
  `pg_catalog.pg_constraint`, `pg_catalog.pg_index`,
  `pg_catalog.pg_class`, `pg_catalog.pg_namespace` and
  `pg_catalog.pg_get_expr`.
- The capture must include candidate SHA, PostgreSQL version, snapshot/source
  identity, command, exit code and rows for every relation named by
  `schema-assumptions.json`.
- DONE requires zero missing relations/columns/constraints/index predicates,
  zero type/nullability/default mismatches and zero `UNKNOWN` verdicts.

Concrete capture command, executed with clone-only credentials:

```bash
set -o pipefail
export DATABASE_URL='<disposable-pg17-live-shape-clone-only>'
npm run migrate
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f \
  reports/post-3.9.312-defect-class-consolidation/harness/schema-catalog-proof.sql \
  > reports/post-3.9.312-defect-class-consolidation/inventory/schema-catalog-proof.json
```

The harness SQL must emit JSON and must reject any server whose identity does
not match `e2e/source-identity.json`. It must never accept a production URL.

## 2. Policy authority

For every policy in `policy-authority.json`, execute the same four cases through
the real consumer path on the clone:

1. valid and dispatchable;
2. missing;
3. disabled/non-dispatchable;
4. malformed or ambiguous duplicate.

Run each case once after cold start and once after warming the loader/cache.
Only case 1 may proceed. Cases 2–4 must return a typed fail-closed result and
must not dispatch, enqueue or reuse stale cached truth.

Required artifact:
`inventory/policy-authority-proof.json`, with policy name, fixture transaction,
consumer/HTTP entry point, cold result, warm result, outbound-attempt count and
verdict. DONE requires all matrix cells PASS and outbound-attempt count zero.

Concrete command:

```bash
set -o pipefail
DATABASE_URL='<disposable-pg17-live-shape-clone-only>' \
EGRESS_CAPTURE_FILE='reports/post-3.9.312-defect-class-consolidation/e2e/policy-egress.ndjson' \
npm run test -- --runInBand \
  tests/policy-authority-postgres.integration.test.ts \
  2>&1 | tee reports/post-3.9.312-defect-class-consolidation/e2e/policy-authority.log
```

## 3. Restart, fencing and replay

For every row in `restart-concurrency.json`, the real HTTP harness must:

- create/identify a nonterminal clone-only record;
- stop and restart the exact candidate process;
- prove the record is discoverable/reconciled after restart;
- issue two concurrent claims and prove exactly one winner;
- issue a stale-owner/stale-generation completion and prove zero mutation;
- replay the identical request and prove stable identity/no duplicate side
  effect;
- send the same idempotency key with a different canonical payload and prove a
  typed conflict;
- capture DB before/after, HTTP transcript, process logs and outbound attempts.

Required artifact:
`inventory/restart-concurrency-proof.json`. Each surface must record record IDs,
worker identities/generations, affected-row counts, HTTP statuses, stable replay
identity, conflict response and verdict. DONE requires every surface PASS,
zero duplicate durable actions and zero outbound attempts.

Concrete command:

```bash
set -o pipefail
DATABASE_URL='<disposable-pg17-live-shape-clone-only>' \
EGRESS_MODE=deny \
npm run test -- --runInBand \
  tests/restart-concurrency-http-postgres.e2e.test.ts \
  2>&1 | tee reports/post-3.9.312-defect-class-consolidation/e2e/restart-concurrency.log
```

## 4. Same-SHA re-review

Record and verify:

```bash
git status --short --branch
git rev-parse HEAD
git diff --check
npm run build
npm test -- --runInBand
PHONE_NETWORK_ANDROID_ROOT=/data/.openclaw/workspace/slavegate/android-agent \
  npm run audit:no-hardcoding
```

`commands.log` must contain commands, timestamps and exit codes. Any committed
change after test capture invalidates Gate 4 evidence. Review order is ECHO then
LENS, both on the exact clean SHA. FORGE may close Gate 4 only after independently
checking artifact completeness and SHA identity. Gate 4 closure does not close
Gates 1–3.
