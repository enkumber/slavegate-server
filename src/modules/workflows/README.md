# workflows — Phase 2

DAG-based workflow engine: template registry, execution tracking, checkpointing.

## What goes here

- `workflow-engine.ts` — DAG execution, step dispatch, checkpoint persistence
- `templates/` — YAML/JSON workflow templates (instagram_browse_and_like, tiktok_watch_videos, etc.)
- `workflow.service.ts` — CRUD for workflow instances, status tracking

## Key design decisions

- Workflows are server-side only. Agent executes atomic jobs, knows nothing about the workflow.
- Each step dispatches one or more atomic jobs via `dispatcherService`.
- Checkpointing: current_step + state saved to DB after each completed step.
- On device reconnect: workflow resumes from last checkpoint.

## Dependencies

- `hbe` module — all timing/jitter parameters are injected by HBE before dispatch
- `dispatcher` module — for actual job dispatch

## Template format

See `ARCHITECTURE_AUDIT.md` section 7 for YAML examples.
