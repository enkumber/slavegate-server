-- Operational source of truth for the generic Android workflow interpreter.
-- Application-specific navigation data remains in app_runtime_profiles/App Maps;
-- this table defines only portable interpreter primitives and safety limits.

CREATE TABLE IF NOT EXISTS workflow_runtime_contracts (
  contract_id TEXT PRIMARY KEY,
  schema_version INT NOT NULL CHECK (schema_version > 0),
  allowed_actions JSONB NOT NULL CHECK (jsonb_typeof(allowed_actions) = 'array'),
  limits JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(limits) = 'object'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO workflow_runtime_contracts (
  contract_id,
  schema_version,
  allowed_actions,
  limits,
  metadata
)
VALUES (
  'edge-workflow/v2',
  2,
  '[
    "a11y_find_tap", "classify_ui_tree", "close_app", "double_tap", "get_foreground_app",
    "get_screen_state", "intent_send", "keyevent", "long_press",
    "ocr_find_tap", "open_app", "press_key", "request_llm", "screen_off", "screen_wake",
    "screenshot", "screenshot_for_vlm", "scroll", "set_focused_text",
    "set_variable", "swipe", "tap", "type_text", "ui_tree_dump", "unlock",
    "wait_for_idle"
  ]'::jsonb,
  '{
    "maxSteps": 500,
    "maxNestedDepth": 8,
    "maxRetriesPerAction": 10,
    "maxStepTimeoutMs": 600000,
    "maxWorkflowTimeoutMs": 3600000,
    "timingMode": "explicit_only",
    "serverStepFallback": false
  }'::jsonb,
  '{
    "operationalSource": "postgresql",
    "applicationKnowledgeAllowed": false,
    "description": "Generic Android edge interpreter contract; app behavior belongs in workflows/App Maps."
  }'::jsonb
)
ON CONFLICT (contract_id) DO UPDATE
SET schema_version = EXCLUDED.schema_version,
    allowed_actions = EXCLUDED.allowed_actions,
    limits = EXCLUDED.limits,
    active = TRUE,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

ALTER TABLE app_runtime_profiles
  ADD COLUMN IF NOT EXISTS workflow_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE app_runtime_profiles
  DROP CONSTRAINT IF EXISTS app_runtime_profiles_workflow_policy_object;

ALTER TABLE app_runtime_profiles
  ADD CONSTRAINT app_runtime_profiles_workflow_policy_object
  CHECK (jsonb_typeof(workflow_policy) = 'object');

UPDATE app_runtime_profiles
SET workflow_policy = workflow_policy || '{
  "runtimeContract":"edge-workflow/v2",
  "timingMode":"explicit_only",
  "serverStepFallback":false,
  "selectorOrder":["resourceId","contentDescription","text","normalizedCoordinates"],
  "defaultVerification":"local_only"
}'::jsonb,
    updated_at = NOW()
WHERE active = TRUE;

-- Legacy application-specific opcodes are intentionally not rewritten here.
-- Rewriting them would embed application knowledge in a release migration.
-- They remain on their legacy contract and cannot pass edge-workflow/v2
-- validation; replacement workflows must be authored as operational DB data.
