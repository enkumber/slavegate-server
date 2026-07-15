# PNQ-001 G1-C Server Egress Inventory

Scope: server-only observe-mode inventory and G1-C evidence for branch `feature/pnq-001-server-device-queue`.

Hard boundaries: no PNEX, no Android, no production edits, no migrations, no package manifest changes, no push/deploy/release/live restart/cron/device mutation.

## Static Scan Contract

The guard in `tests/pnq-001/static-egress-guard.test.ts` scans production TypeScript under `src/`, excluding tests, backup files, docs, source maps, and DB migrations. It now parses TypeScript AST nodes instead of raw lines, so comments and string literals cannot satisfy or hide the inventory. It records:

- call expressions for device send primitives and raw websocket serializers;
- `sendJobToDevice` facade declarations;
- `sendToDevice` method declarations because they are raw transport surfaces.

It fails when the set of file-plus-egress-primitive counts differs from `evidence/PNQ-001/static-egress-baseline.json`.

This is intentionally conservative for G1 observe-mode:

- New production senders fail until classified.
- Extra calls in already-known sender files fail until reviewed.
- Removed calls fail so FORGE can reconcile the inventory.
- The guard does not assert PNQ admission behavior yet; it preserves the static baseline for VOLT/FORGE integration review.
- The AST scan added one previously untracked internal edge: `src/transport/transport.ts` calls `directWsServer.sendJob()` inside the facade.

## Current Production Egress Baseline

| File | Primitive | Count | Classification | Notes |
| --- | --- | ---: | --- | --- |
| `src/transport/transport.ts` | `directWsServer.sendJob` | 1 | direct ws job transport internal | Internal DirectWS job send inside the facade; G2 must make this permit-bound and keep it internal. |
| `src/transport/transport.ts` | `sendJobToDevice` | 1 | device job transport facade | Central DirectWS facade used by most server job senders. |
| `src/ws/direct-ws.server.ts` | `sendToDevice` | 1 | direct device control transport | Generic DirectWS control/data sender. |
| `src/ws/direct-ws.server.ts` | `ws.send` | 1 | raw websocket serializer | Underlying DirectWS serializer. |
| `src/ws/ws.server.ts` | `sendToDevice` | 6 | legacy device transport/control | Legacy ECDSA server sends job dispatch, auth revoke, kill switch, OTA. |
| `src/ws/ws.server.ts` | `ws.send` | 2 | raw websocket serializer | PONG plus legacy serializer. |
| `src/ws/gateway.ts` | `ws.send` | 1 | legacy gateway serializer | Gateway serializer path; not imported by `transport.ts`. |
| `src/api/routes.ts` | `transport.sendJob` | 1 | raw API job ingress | `POST /jobs` dispatches and sends a raw job. |
| `src/api/routes.ts` | `sendJobToDevice` | 1 | transport adapter factory | `getActiveTransport()` delegates raw API sends to facade. |
| `src/api/routes.ts` | `directWsServer.sendWorkflowCancel` | 1 | workflow cancel control | Sends edge workflow cancel after DB cancel. |
| `src/api/routes.ts` | `directWsServer.sendToDevice` | 2 | device control broadcast | Model config update and OTA push. |
| `src/api/routes.ts` | `sendToDevice` | 2 | duplicate primitive match | Same two `directWsServer.sendToDevice` calls, tracked to catch generic use. |
| `src/api/hydra-routes.ts` | `sendJobToDevice` | 22 | Hydra device-affecting jobs | Cascade/navigation/screenshot/OCR/tap routes send direct jobs after DB dispatch. |
| `src/modules/app-mapping/mapping-routes.ts` | `sendJobToDevice` | 1 | app mapping route | UI tree dump for mapping. |
| `src/modules/app-mapping/recorder.service.ts` | `sendJobToDevice` | 1 | app mapping recorder | UI tree capture for recorder. |
| `src/modules/skills/skill.cascade.ts` | `sendJobToDevice` | 1 | skill adapter facade | Default adapter wraps the transport facade. |
| `src/modules/skills/skill.cascade.ts` | `adapter.sendJob` | 9 | skill cascade jobs | Back/home/tap/a11y/OCR/VLM cascade adapter sends. |
| `src/modules/screen-detection/screen-detection.service.ts` | `sendJobToDevice` | 4 | screen detection jobs | VLM/UI/OCR/screenshot detection paths. |
| `src/modules/workflows/workflow-dispatch.service.ts` | `sendJobToDevice` | 3 | workflow dispatch/cancel | Pre-workflow jobs, remaining workflow execute, cancel workflow. |
| `src/modules/workflows/generated-workflow-execution.service.ts` | `directWsServer.sendWorkflowStart` | 1 | edge generated workflow | Starts device-side workflow when edge-capable. |
| `src/modules/workflows/workflow.executor.ts` | `sendJobToDevice` | 3 | server workflow executor jobs | Server-mode workflow step sends. |
| `src/modules/workflows/workflow.executor.ts` | `directWsServer.sendBatch` | 1 | workflow batch transport | Compiled batch execution. |
| `src/modules/workflow-compiler/runner.service.ts` | `sendJobToDevice` | 10 | compiled workflow runner jobs | Legacy/semantic compiled runner sends. |
| `src/modules/workflow-compiler/runner.service.ts` | `directWsServer.sendBatch` | 1 | compiled batch transport | Batch runner send. |
| `src/modules/workflow-compiler/recovery.service.ts` | `sendJobToDevice` | 4 | recovery jobs | Recovery UI/screenshot/tap jobs. |
| `src/modules/agents/orchestrator.ts` | `sendJobToDevice` | 16 | orchestrator jobs | Agent/orchestrator screenshot, tap, navigation, capture paths. |
| `src/modules/workflow-events/workflow-event.service.ts` | `ws.send` | 2 | dashboard event egress | Non-device workflow event websocket egress; included because it is raw websocket production egress. |

## Root-Boundary Matrix

| Boundary | Current production entrypoints | Canonical PNQ root | Child/egress mapping needed | Release policy | G1-C status |
| --- | --- | --- | --- | --- | --- |
| Standalone JOB | `POST /api/jobs`, Hydra routes, screen detection, app mapping, skills, orchestrator, compiler/recovery job sends | `root_kind=job`, root id mapped to `jobId` | Job id must map to root id, device id, owner generation, state | Release only on device-terminal JOB result or audited cancel/fail | Real-PostgreSQL harness covers FIFO drain, two-worker claim, wrong-device and duplicate terminal rejection; stale owner-generation rejection depends on separately owned production terminal input. |
| Edge BATCH | `directWsServer.sendBatch()` from workflow executor and compiler runner | `root_kind=batch`, root id mapped to `batchId` | Batch id and optional workflow id must map to one root | Release only on terminal BATCH result or audited admin resolution | Inventory covers sender; terminal CAS and waiter registration need production API. |
| Edge WORKFLOW | `directWsServer.sendWorkflowStart()` from generated workflow execution | `root_kind=edge_workflow`, root id mapped to `workflowId` | Workflow id must be the root identity across start, wait, cancel, result | Release only on terminal edge workflow result/cancel/fail | Inventory covers sender; result correlation and cancel semantics remain production dependencies. |
| Server WORKFLOW | Workflow dispatch service, workflow executor, workflow compiler runner, task runner | `root_kind=server_workflow`, root id mapped to server workflow/run id | Every child job/batch must point to the server-workflow root and reuse its owner generation | Children cannot release; release only when the server workflow is terminal | Durable operation ledger and child re-entry API must come from separately owned production remediation; SPARK did not patch them. |
| Generated/self-healing/prestep/recovery children | Generated workflow runner, compiler recovery, screen verifier, pre-workflow jobs | Inherit parent `server_workflow`, `edge_workflow`, or `job` root depending on caller | Child job/batch/workflow ids need immutable ledger rows with parent root id and owner generation | No child may advance the queue independently | Inventory covers known senders; canonical child/root handle must come from separately owned production remediation. |
| Control egress | Workflow cancel, OTA update, model config, auth revoke, kill switch | Either `root_kind=control` or audited emergency control lane | Must carry control type, operator/system actor, reason, and target device; must be impossible to encode ordinary UI work | Must not release or mutate ordinary execution roots unless policy explicitly says so | Policy unresolved; matrix below defines review decision points. |
| Dashboard/non-device websocket | Workflow event dashboard websocket | No device root | Keep out of device queue; optionally track in a separate websocket egress inventory | No queue release effect | Included in static guard only because it is raw production websocket egress. |

## Control/Admin/Multi-Worker Policy Matrix

| Area | Proposed policy | Required audit fields | G1-C evidence | Open dependency |
| --- | --- | --- | --- | --- |
| Normal device egress | DB authorization, CAS into dispatching/claimed state, register waiter, wire send, CAS dispatched | root id, device id, owner generation, sender, state transition, wire result | Real-PostgreSQL claim/dispatch/terminal harness exists | Single async egress API is missing; current senders still call transport primitives directly. |
| Workflow cancel control | May use a narrow control lane only for cancellation, never for UI work | workflow id, device id, actor, reason, previous root state, control type | Static inventory classifies `sendWorkflowCancel` | FORGE/VOLT must choose queue participation versus audited bypass. |
| OTA/model config/auth revoke/kill switch | Emergency/admin control lane; cannot release queued/running roots by itself | admin/system actor, target device set, payload type, reason, result | Static inventory classifies legacy and DirectWS control surfaces | Admin authentication and resolution API are outside current G1-C test ownership. |
| Administrative resolution | Only explicit authenticated resolution may move ambiguous roots out of `reconciling`/`blocked` | operator, reason, old state, new state, root id, device id, owner generation | Crash/restart ambiguity harness verifies successors stay queued while root is `reconciling` | No production admin-resolution interface exists yet. |
| Multi-worker root claims | PostgreSQL advisory device lock plus active-slot unique index; only one worker can claim a device root | worker actor, root id, device id, claim result | Real-PostgreSQL two-worker claim race harness exists | None for observe-mode claim; enforcement integration still pending. |
| Multi-worker websocket ownership | One canonical root/device/owner-generation handle must be validated before result release; stale workers cannot release successors | websocket connection generation, root owner generation, result correlation id | Wrong-device and duplicate terminal rejection harness exists | FORGE should verify separately owned production remediation exposes owner-generation terminal checks and canonical websocket ownership. |
| Startup reconciliation | Startup must fail closed before admission/dispatch if roots are ambiguous or schema is invalid | startup id, root id, reason, schema verdict, reconciliation state | Harness simulates restart ambiguity and schema-index failure | No startup reconciliation hook is exposed for direct test. |

## Dispatch-Only Producers

These production files create dispatcher records or workflow roots and may become PNQ admission roots even when they do not directly call a transport primitive in the same file:

- `src/api/workflow-dispatch-routes.ts`: `dispatchWorkflow()` HTTP ingress.
- `src/api/routes.ts`: raw jobs and generated workflow execution HTTP ingress.
- `src/modules/discovery/discovery.service.ts`: discovery probes via `dispatcherService.dispatch()`.
- `src/modules/ota/ota.service.ts`: OTA deployment records via `dispatcherService.dispatch()`.
- `src/modules/task-runner/task-runner.service.ts`: generated workflow task runner via `dispatchGeneratedWorkflowTemplate()`.
- `src/modules/workflows/workflow-dispatch.service.ts`: workflow root dispatch plus pre-step jobs.
- `src/modules/workflows/generated-workflow-execution.service.ts`: generated workflow edge/server root selection.
- `src/modules/workflows/workflow.executor.ts`: server workflow step dispatch.
- `src/modules/skills/skill.cascade.ts`: cascade action dispatch records before adapter sends.
- `src/modules/app-mapping/*`: mapping recorders/routes dispatch before UI tree sends.
- `src/api/hydra-routes.ts`: many route-level dispatcher records followed by transport sends.

## Exclusions

- Tests: already non-production and frequently mock send primitives.
- `*.backup`: excluded because `src/api/hydra-routes.ts.backup` is not production.
- Docs, generated maps, and shared protocol declarations: not executable senders.
- DB migrations: mention dispatch semantics but do not send to devices.
- Scripts: `scripts/engage-session.js` is operational tooling, not server production source; if FORGE wants script ingress guarded, add a separate owner decision.

## Dependency / Interface Needs For VOLT and FORGE

- A single server-owned admission API is needed before any of the device-affecting primitives above can be made safe: raw job, workflow root, workflow step, generated workflow edge start, batch start, cancel/control, OTA/model config control, and skill/app-mapping/screen-detection helpers.
- VOLT needs to define whether control egress (`WORKFLOW_CANCEL`, `MODEL_CONFIG_UPDATED`, `OTA_UPDATE`, kill switch/auth revoke) participates in the same per-device FIFO lease or uses a separately audited emergency/control lane.
- VOLT needs to expose a root execution identity for child sends so the guard can later assert child sends are tied to a permit rather than merely present in the static allowlist.
- FORGE should decide whether non-device websocket egress (`workflow-event.service.ts`) remains in this guard or moves to a separate dashboard-egress inventory.
- FORGE should verify separately owned production remediation exposes an owner-generation terminal argument so stale workers/results are rejected by device + root + generation rather than only by device + root.
- Startup reconciliation needs a callable server hook so crash-before/after-send and crash-before/after-result boundaries can be tested without simulating ambiguity through `markAmbiguous()`.
