-- Migration: 029_compiled_workflows.sql
-- Tables for Workflow Compiler + Runner (Story: US-WORKFLOW-COMPILER)
-- compiled_workflows: cache + execution history for AI-compiled workflows
-- recovery_history: audit trail for AI recovery attempts

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMPILED WORKFLOWS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS compiled_workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  source          TEXT NOT NULL,                -- Original NL instruction
  app_id          TEXT NOT NULL,                -- Target app package name
  app_map_version TEXT,                         -- App map version used for compilation
  compiled_data   JSONB NOT NULL,               -- Full CompiledWorkflow JSON
  status          TEXT NOT NULL,
  execution_stats JSONB,                        -- Runtime stats after execution
  total_steps     INTEGER,
  steps_completed INTEGER DEFAULT 0,
  recovery_count  INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compiled_workflows_app ON compiled_workflows(app_id);
CREATE INDEX IF NOT EXISTS idx_compiled_workflows_status ON compiled_workflows(status);
CREATE INDEX IF NOT EXISTS idx_compiled_workflows_source ON compiled_workflows(source);

-- ═══════════════════════════════════════════════════════════════════════════════
-- RECOVERY HISTORY
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS recovery_history (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id         UUID NOT NULL REFERENCES compiled_workflows(id) ON DELETE CASCADE,
  step_index          INTEGER NOT NULL,
  step_id             TEXT NOT NULL,
  failure_reason      TEXT NOT NULL,
  recovery_action     TEXT NOT NULL,             -- retry_step | retry_with_adaptation | dismiss_and_retry | navigate_back_and_retry | abort
  success             BOOLEAN DEFAULT FALSE,
  screenshot_available BOOLEAN DEFAULT FALSE,
  ui_tree_hash        TEXT,
  llm_model           TEXT,
  llm_latency_ms      INTEGER,
  total_latency_ms    INTEGER,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recovery_history_workflow ON recovery_history(workflow_id);
CREATE INDEX IF NOT EXISTS idx_recovery_history_created ON recovery_history(created_at);
CREATE INDEX IF NOT EXISTS idx_recovery_history_action ON recovery_history(recovery_action);
