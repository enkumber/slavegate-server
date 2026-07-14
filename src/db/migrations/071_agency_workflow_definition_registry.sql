-- Workflow Definition Registry: declarative, versioned workflow definitions.
-- This registry is read-only for the compiler until policy gates explicitly change.

CREATE TABLE IF NOT EXISTS agency_workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  title TEXT NOT NULL,
  description TEXT,
  platform TEXT NOT NULL,
  intent TEXT NOT NULL,
  goal TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'static_seed',
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  fallback_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  rollback JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL DEFAULT 'migration',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (definition_key, version)
);

CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_status
  ON agency_workflow_definitions(status);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_platform
  ON agency_workflow_definitions(platform);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_intent
  ON agency_workflow_definitions(intent);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_key
  ON agency_workflow_definitions(definition_key);

INSERT INTO agency_workflow_definitions (
  definition_key,
  version,
  status,
  title,
  description,
  platform,
  intent,
  goal,
  source,
  definition,
  success_criteria,
  allowed_tools,
  required_capabilities,
  constraints,
  fallback_rules,
  rollback,
  policy
)
VALUES
  (
    'reddit_account_health_scan',
    1,
    'active',
    'Reddit account health scan',
    'Read-only workflow definition for checking Reddit account state from UI evidence.',
    'reddit',
    'reddit_account_health_scan',
    'Open Reddit, inspect the account state, and classify health without mutating account data.',
    'static_seed',
    '{"steps":["wake_device","unlock_if_needed","open_reddit","dump_ui_tree","classify_reddit_health_scan"],"terminalStates":["success","expected_failure","quarantined"],"sideEffects":[]}'::jsonb,
    '["loggedIn is classified from UI tree","homeFeedVisible is classified when feed elements are present","challengeDetected and loginWallDetected are explicit booleans","screenState is one of the known Reddit states","no mutating actions are executed"]'::jsonb,
    '["screen_wake","unlock","open_app","ui_tree_dump","get_screen_state","classify_reddit_health_scan"]'::jsonb,
    '["device.online_or_approved","android.edge_workflow","app.reddit.available","ui_tree.readable"]'::jsonb,
    '["read_only_only","no_posting","no_commenting","no_account_switching","no_cache_promotion_without_evidence"]'::jsonb,
    '["if app unavailable mark expected_failure","if login wall detected classify login_wall_detected","if challenge detected classify challenge_detected","if UI tree unavailable require manual review"]'::jsonb,
    '{"required":false,"reason":"read_only_workflow_no_mutating_side_effects"}'::jsonb,
    '{"readOnly":true,"compilerVisible":false,"autoUseEnabled":false,"executionChanging":false,"workflowCacheChanging":false,"mode":"workflow_definition_registry_read_only"}'::jsonb
  ),
  (
    'gmail_open_inbox',
    1,
    'draft',
    'Open Gmail inbox',
    'Draft workflow definition for opening Gmail and proving inbox/app shell state.',
    'gmail',
    'gmail_open_inbox',
    'Open Gmail and verify the inbox or signed-in app shell without composing or sending messages.',
    'static_seed',
    '{"steps":["wake_device","unlock_if_needed","open_gmail","dump_ui_tree","classify_gmail_state"],"terminalStates":["success","expected_failure","needs_review"],"sideEffects":[]}'::jsonb,
    '["Gmail app package or verified Gmail surface is visible","inbox or signed-in app shell is detected","login wall is classified separately","no compose or send action is executed"]'::jsonb,
    '["screen_wake","unlock","open_app","ui_tree_dump","get_screen_state"]'::jsonb,
    '["device.online_or_approved","gmail.app_or_surface_available","ui_tree.readable"]'::jsonb,
    '["do_not_use_chrome_as_gmail_default","no_email_compose","no_send","scope_user_device_until_validated"]'::jsonb,
    '["if login wall detected stop as expected_failure","if package unavailable mark needs_review","if account mismatch detected require manual review"]'::jsonb,
    '{"required":false,"reason":"read_only_navigation_only"}'::jsonb,
    '{"readOnly":true,"compilerVisible":false,"autoUseEnabled":false,"executionChanging":false,"workflowCacheChanging":false,"mode":"workflow_definition_registry_read_only"}'::jsonb
  ),
  (
    'device_unlock',
    1,
    'active',
    'Unlock device',
    'Small reusable workflow definition for bringing an approved device to an unlocked ready state.',
    'android',
    'device_unlock',
    'Wake and unlock a device when policy and device state allow it.',
    'static_seed',
    '{"steps":["wake_device","unlock_if_needed","verify_unlocked_state"],"terminalStates":["success","expected_failure","needs_review"],"sideEffects":["device_unlock_attempt"]}'::jsonb,
    '["device reports unlocked or usable foreground state","lock screen is not visible after unlock attempt","retry count stays within threshold","failure reason is classified when unlock is not possible"]'::jsonb,
    '["screen_wake","unlock","get_screen_state"]'::jsonb,
    '["device.online_or_approved","unlock.capability_available"]'::jsonb,
    '["no_credential_disclosure","limited_reuse_scope_required","no_retry_storm"]'::jsonb,
    '["if unlock method unavailable classify expected_failure","if repeated failure stop and require review","if device offline stop without queueing side effects"]'::jsonb,
    '{"required":true,"strategy":"stop_after_threshold_and_report_state"}'::jsonb,
    '{"readOnly":true,"compilerVisible":false,"autoUseEnabled":false,"executionChanging":false,"workflowCacheChanging":false,"mode":"workflow_definition_registry_read_only"}'::jsonb
  )
ON CONFLICT (definition_key, version) DO NOTHING;
