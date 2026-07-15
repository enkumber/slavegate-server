# PNQ-001 G1-B Server Egress Inventory

Scope: server-only observe-mode inventory for branch `feature/pnq-001-server-device-queue` at base `51668e45ffaf9754401a9c80e3a1ee8508bd524d`.

Hard boundaries: no PNEX, no Android, no production edits, no migrations, no package manifest changes, no push/deploy/release/live restart/cron/device mutation.

## Static Scan Contract

The guard in `tests/pnq-001/static-egress-guard.test.ts` scans production TypeScript under `src/`, excluding tests, backup files, docs, source maps, and DB migrations. It fails when the set of file-plus-egress-primitive counts differs from `evidence/PNQ-001/static-egress-baseline.json`.

This is intentionally conservative for G1 observe-mode:

- New production senders fail until classified.
- Extra calls in already-known sender files fail until reviewed.
- Removed calls fail so FORGE can reconcile the inventory.
- The guard does not assert PNQ admission behavior yet; it preserves the G1-B static baseline for VOLT/FORGE integration review.

## Current Production Egress Baseline

| File | Primitive | Count | Classification | Notes |
| --- | --- | ---: | --- | --- |
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

