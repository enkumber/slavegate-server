-- Controlled Auto-use Execution v1.
-- Bootstrap the policy gates and seed workflow definitions for scoped test execution.

ALTER TABLE agency_workflow_definition_version_events
  DROP CONSTRAINT IF EXISTS agency_workflow_definition_version_events_action_check;

ALTER TABLE agency_workflow_definition_version_events
  ADD CONSTRAINT agency_workflow_definition_version_events_action_check
  CHECK (action IN (
    'create_version',
    'archive',
    'deprecate',
    'activate',
    'draft',
    'hardening_preview',
    'auto_use_enablement',
    'auto_use_execution_queued'
  ));

INSERT INTO agency_compiler_policy_gate_config (gate_id, state, version, owner, risk, config, updated_by, updated_at)
VALUES
  ('compiler_tool_visibility', 'enabled', 2, 'engineering', 'medium',
   '{"explicitApproval":true,"rollout":"test_scope","killSwitch":false}'::jsonb, 'migration_077', NOW()),
  ('compiler_knowledge_application', 'enabled', 2, 'product', 'medium',
   '{"explicitApproval":true,"rollout":"test_scope","killSwitch":false}'::jsonb, 'migration_077', NOW()),
  ('step_compiler_eligibility', 'enabled', 2, 'qa', 'high',
   '{"explicitApproval":true,"rollout":"test_scope","killSwitch":false}'::jsonb, 'migration_077', NOW()),
  ('limited_reuse_scope_match', 'enabled', 2, 'qa', 'high',
   '{"explicitApproval":true,"rollout":"test_scope","killSwitch":false}'::jsonb, 'migration_077', NOW()),
  ('compiler_auto_use', 'enabled', 2, 'product', 'high',
   '{"explicitApproval":true,"rollout":"test_scope","killSwitch":false}'::jsonb, 'migration_077', NOW()),
  ('execution_path_change', 'enabled', 2, 'security', 'high',
   '{"explicitApproval":true,"rollout":"test_scope","killSwitch":false,"executionRoute":"generated_workflow_queue"}'::jsonb, 'migration_077', NOW())
ON CONFLICT (gate_id)
DO UPDATE SET state = EXCLUDED.state,
              version = GREATEST(agency_compiler_policy_gate_config.version + 1, EXCLUDED.version),
              owner = EXCLUDED.owner,
              risk = EXCLUDED.risk,
              config = EXCLUDED.config,
              updated_by = EXCLUDED.updated_by,
              updated_at = NOW();

INSERT INTO agency_compiler_policy_gate_events (gate_id, previous_state, next_state, version, note, actor, config, policy)
SELECT gate_id,
       'blocked',
       state,
       version,
       'Bootstrap controlled auto-use execution for simple test scopes',
       'migration_077',
       config,
       jsonb_build_object(
         'autoUseEnabled', true,
         'executionChanging', true,
         'workflowCacheChanging', true,
         'safeToAutoApply', true,
         'mode', 'controlled_auto_use_execution_v1',
         'executionRoute', 'generated_workflow_queue'
       )
FROM agency_compiler_policy_gate_config
WHERE updated_by = 'migration_077';

UPDATE agency_workflow_definitions
SET promotion_state = 'limited_reuse',
    promotion_scope = CONCAT('auto_use:test:', platform, ':', intent, ':v', version),
    promotion_note = 'Auto-use bootstrap for simple scoped Phone Network tests',
    promotion_confidence = GREATEST(COALESCE(promotion_confidence, 0), 0.85),
    promotion_readiness = jsonb_build_object(
      'state', 'auto_use_bootstrap_ready',
      'manualOnly', false,
      'autoUseEnabled', true,
      'executionRoute', 'generated_workflow_queue',
      'wouldUseDefinition', true,
      'wouldExecuteWorkflow', true,
      'wouldChangeWorkflowCache', true,
      'safeToAutoApply', true,
      'blockers', '[]'::jsonb
    ),
    promotion_scope_details = jsonb_build_object(
      'scope', CONCAT('auto_use:test:', platform, ':', intent, ':v', version),
      'scopeType', 'auto_use',
      'scopeValue', CONCAT('test:', platform, ':', intent, ':v', version),
      'limitedReuseOnly', true,
      'globalScopeAllowed', false,
      'compilerEligible', true,
      'wouldUseDefinition', true,
      'wouldExecuteWorkflow', true
    ),
    policy = COALESCE(policy, '{}'::jsonb) || jsonb_build_object(
      'readOnly', false,
      'compilerVisible', true,
      'autoUseEnabled', true,
      'executionChanging', true,
      'workflowCacheChanging', true,
      'mode', 'controlled_auto_use_execution_v1'
    ),
    promoted_by = COALESCE(promoted_by, 'migration_077'),
    promoted_at = COALESCE(promoted_at, NOW()),
    revoked_by = NULL,
    revoked_at = NULL,
    updated_at = NOW()
WHERE status = 'active'
  AND promotion_state <> 'limited_reuse';

INSERT INTO agency_workflow_definition_version_events (
  definition_id,
  definition_key,
  definition_version,
  action,
  previous_status,
  next_status,
  note,
  actor,
  diff,
  impact_preview,
  policy
)
SELECT id,
       definition_key,
       version,
       'auto_use_enablement',
       status,
       status,
       'Controlled auto-use enabled for simple scoped tests',
       'migration_077',
       '{}'::jsonb,
       jsonb_build_object(
         'promotionState', promotion_state,
         'promotionScope', promotion_scope,
         'promotionConfidence', promotion_confidence,
         'promotionReadiness', promotion_readiness
       ),
       jsonb_build_object(
         'autoUseEnabled', true,
         'executionChanging', true,
         'workflowCacheChanging', true,
         'safeToAutoApply', true,
         'mode', 'controlled_auto_use_execution_v1'
       )
FROM agency_workflow_definitions
WHERE status = 'active'
  AND promotion_state = 'limited_reuse';
