-- Application/workflow semantics are PostgreSQL authority.
-- The server keeps only the versioned Goal Contract parser, generic primitive
-- validation, effect lattice, bindings and execution safety kernel.

CREATE TABLE IF NOT EXISTS runtime_semantic_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '*',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'quarantined')),
  priority INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (namespace, entry_key)
);

CREATE INDEX IF NOT EXISTS idx_runtime_semantic_entries_lookup
  ON runtime_semantic_entries (namespace, platform, status, priority DESC);

INSERT INTO runtime_semantic_entries (namespace, entry_key, platform, priority, payload)
VALUES
  ('account_detection_rule', 'instagram_account_disabled', 'instagram', 100,
    '{"pattern":"action_blocked|blocked_actions|your account has been disabled","flags":"i","signal":{"type":"banned","reason":"Action blocked — account disabled","confidence":0.95}}'),
  ('account_detection_rule', 'instagram_identity_verification', 'instagram', 90,
    '{"pattern":"verify your account|confirm your identity|suspicious activity","flags":"i","signal":{"type":"challenged","reason":"Identity verification required","confidence":0.9}}'),
  ('account_detection_rule', 'instagram_rate_limit', 'instagram', 80,
    '{"pattern":"try again later|please wait a few minutes|too many requests","flags":"i","signal":{"type":"rate_limited","reason":"Platform rate limit detected","confidence":0.8}}'),
  ('account_detection_rule', 'instagram_session_expired', 'instagram', 70,
    '{"pattern":"login required|you''ve been logged out|session expired","flags":"i","signal":{"type":"challenged","reason":"Session expired — re-login required","confidence":0.85}}'),
  ('account_detection_rule', 'tiktok_account_banned', 'tiktok', 100,
    '{"pattern":"account has been banned|community guidelines violation","flags":"i","signal":{"type":"banned","reason":"Account ban detected","confidence":0.95}}'),
  ('account_detection_rule', 'tiktok_verification', 'tiktok', 90,
    '{"pattern":"unusual activity|captcha|verify|phone number","flags":"i","signal":{"type":"challenged","reason":"Verification challenge","confidence":0.85}}'),
  ('account_detection_rule', 'tiktok_rate_limit', 'tiktok', 80,
    '{"pattern":"too frequent|slow down|limit reached","flags":"i","signal":{"type":"rate_limited","reason":"Platform rate limit detected","confidence":0.75}}'),
  ('account_detection_rule', 'reddit_account_suspended', 'reddit', 100,
    '{"pattern":"permanently suspended|account suspended|banned from","flags":"i","signal":{"type":"banned","reason":"Account suspended","confidence":0.95}}'),
  ('account_detection_rule', 'reddit_shadowban', 'reddit', 90,
    '{"pattern":"you''ve been shadowbanned|posts not visible","flags":"i","signal":{"type":"banned","reason":"Shadowban detected","confidence":0.8}}'),
  ('account_detection_rule', 'reddit_verification', 'reddit', 80,
    '{"pattern":"verify email|verify your account|captcha required","flags":"i","signal":{"type":"challenged","reason":"Verification required","confidence":0.85}}'),
  ('account_detection_rule', 'reddit_rate_limit', 'reddit', 70,
    '{"pattern":"you are doing that too much|ratelimit|try again in","flags":"i","signal":{"type":"rate_limited","reason":"Platform rate limit detected","confidence":0.75}}'),
  ('account_detection_rule', 'generic_session_expired', '*', 30,
    '{"pattern":"login required|please log in|session expired","flags":"i","signal":{"type":"challenged","reason":"Session expired","confidence":0.7}}'),
  ('account_detection_rule', 'generic_account_banned', '*', 20,
    '{"pattern":"account disabled|account banned|permanently banned","flags":"i","signal":{"type":"banned","reason":"Account ban detected","confidence":0.8}}'),
  ('account_detection_rule', 'generic_human_verification', '*', 10,
    '{"pattern":"captcha|verify you''re human|prove you''re not a robot","flags":"i","signal":{"type":"challenged","reason":"Human verification challenge","confidence":0.85}}')
ON CONFLICT (namespace, entry_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  priority = EXCLUDED.priority,
  payload = EXCLUDED.payload,
  status = 'active',
  updated_at = NOW();

INSERT INTO runtime_semantic_entries (namespace, entry_key, platform, priority, payload)
VALUES
  ('incident_routing_rule', 'security', '*', 100,
    '{"pattern":"credential|secret|token|exfiltrat|unauthori[sz]ed|permission|security","flags":"i","category":"security","severity":"critical","owner":"dan"}'),
  ('incident_routing_rule', 'availability', '*', 90,
    '{"pattern":"offline|disconnect|unreachable|no device|not connected","flags":"i","category":"availability","severity":"high","owner":"nox"}'),
  ('incident_routing_rule', 'account', '*', 80,
    '{"pattern":"account|login|challenge|captcha|verification","flags":"i","category":"account","severity":"high","owner":"nox"}'),
  ('incident_routing_rule', 'integrity', '*', 70,
    '{"pattern":"mismatch|contradict|invalid state|checkpoint|integrity","flags":"i","category":"integrity","severity":"high","owner":"nox"}'),
  ('incident_routing_rule', 'default', '*', 0,
    '{"pattern":".*","flags":"i","category":"execution","severity":"medium","owner":"nox"}')
ON CONFLICT (namespace, entry_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  priority = EXCLUDED.priority,
  payload = EXCLUDED.payload,
  status = 'active',
  updated_at = NOW();

INSERT INTO runtime_semantic_entries (namespace, entry_key, platform, priority, payload)
VALUES
  (
    'vision_prompt',
    'element_find:default',
    '*',
    0,
    '{"prompt":"Analyze this Android screenshot and identify interactive UI elements. Return JSON with elements (type, text, bounds, confidence), scene_description, and detected_state. Return an empty elements array when no reliable element is visible."}'::jsonb
  ),
  (
    'vision_prompt',
    'verify_action:default',
    '*',
    0,
    '{"prompt":"Compare the visible Android UI with the declared postcondition for the completed action. Return JSON: {\"success\":boolean,\"confidence\":number,\"observation\":string}. Do not infer success without visible evidence."}'::jsonb
  ),
  (
    'vision_prompt',
    'screen_understand:default',
    '*',
    0,
    '{"prompt":"Analyze this Android screenshot. Return JSON with interactive elements, a concise scene_description, detected_state, and alerts. Describe only visible evidence and use unknown when state cannot be established."}'::jsonb
  ),
  (
    'vision_prompt',
    'screen_classification:default',
    '*',
    0,
    '{"prompt":"Classify the visible Android UI using only the state identifiers supplied by the workflow context. Return JSON with screen, confidence, visible elements, and overlays. Return unknown when no supplied state is supported by visible evidence."}'::jsonb
  )
ON CONFLICT (namespace, entry_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  priority = EXCLUDED.priority,
  payload = EXCLUDED.payload,
  status = 'active',
  updated_at = NOW();

INSERT INTO runtime_semantic_entries (namespace, entry_key, platform, priority, payload)
VALUES
  ('tool_catalog', 'screen_wake', 'android', 100,
    '{"id":"screen_wake","name":"Wake screen","source":"device_job","category":"device_control","description":"Wake the device screen.","risk":"low","requiresDevice":true,"sideEffects":["screen_state"],"inputSchema":{"required":[],"optional":[]},"outputSchema":{"produces":["wake_status"]},"policy":{"readOnly":false,"mutating":true,"destructive":false,"externalAction":false},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb),
  ('tool_catalog', 'unlock', 'android', 95,
    '{"id":"unlock","name":"Unlock device","source":"device_job","category":"device_control","description":"Unlock a compatible device.","risk":"medium","requiresDevice":true,"sideEffects":["device_unlocked"],"inputSchema":{"required":[],"optional":[]},"outputSchema":{"produces":["unlock_status"]},"policy":{"readOnly":false,"mutating":true,"destructive":false,"externalAction":false},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb),
  ('tool_catalog', 'open_app', 'android', 90,
    '{"id":"open_app","name":"Open application","source":"device_job","category":"navigation","description":"Open a package supplied by the selected runtime profile.","risk":"medium","requiresDevice":true,"sideEffects":["foreground_app_change"],"inputSchema":{"required":["packageName"],"optional":["uri"]},"outputSchema":{"produces":["launch_status"]},"policy":{"readOnly":false,"mutating":true,"destructive":false,"externalAction":false},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb),
  ('tool_catalog', 'semantic_tap', 'android', 85,
    '{"id":"semantic_tap","name":"Semantic tap","source":"device_job","category":"input","description":"Resolve and activate a catalog-defined UI target.","risk":"high","requiresDevice":true,"sideEffects":["ui_interaction"],"inputSchema":{"required":["target"],"optional":["waitMs"]},"outputSchema":{"produces":["tap_status","resolution_trace"]},"policy":{"readOnly":false,"mutating":true,"destructive":false,"externalAction":true},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb),
  ('tool_catalog', 'observe_and_transition', 'android', 80,
    '{"id":"observe_and_transition","name":"Observe and transition","source":"device_job","category":"workflow","description":"Poll declared selectors, execute one transition, and require its postcondition.","risk":"high","requiresDevice":true,"sideEffects":["ui_interaction"],"inputSchema":{"required":["selectors","postcondition"],"optional":["pollIntervalMs","settleMs","allowAlreadySatisfied","sourceState","targetState"]},"outputSchema":{"produces":["verified","selectorAttempts","observationAttempts","selectedIndex","lastOutput"]},"policy":{"readOnly":false,"mutating":true,"destructive":false,"externalAction":true},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb),
  ('tool_catalog', 'run_state_machine', 'android', 75,
    '{"id":"run_state_machine","name":"Run state machine","source":"workflow_runtime","category":"workflow","description":"Resolve declared states and execute verified transitions until a goal state.","risk":"high","requiresDevice":true,"sideEffects":["ui_interaction"],"inputSchema":{"required":["stateVariable","resolver","goalStates","transitions"],"optional":["unknownStates","maxIterations","settleMs"]},"outputSchema":{"produces":["goalReached","finalState","statePath","transitions"]},"policy":{"readOnly":false,"mutating":true,"destructive":false,"externalAction":true},"availability":{"directWs":false,"edgeWorkflow":true,"serverRuntime":true},"notes":[]}'::jsonb),
  ('tool_catalog', 'type_text', 'android', 70,
    '{"id":"type_text","name":"Type text","source":"device_job","category":"input","description":"Type literal or bound text into the focused field.","risk":"high","requiresDevice":true,"sideEffects":["ui_input"],"inputSchema":{"required":[],"optional":["text","textFromVariable"]},"outputSchema":{"produces":["type_status"]},"policy":{"readOnly":false,"mutating":true,"destructive":false,"externalAction":true},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb),
  ('tool_catalog', 'ui_tree_dump', 'android', 65,
    '{"id":"ui_tree_dump","name":"Read UI tree","source":"device_job","category":"observation","description":"Read the current accessibility tree.","risk":"low","requiresDevice":true,"sideEffects":["sensitive_ui_snapshot"],"inputSchema":{"required":[],"optional":["packageName"]},"outputSchema":{"produces":["ui_tree"]},"policy":{"readOnly":true,"mutating":false,"destructive":false,"externalAction":false},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb),
  ('tool_catalog', 'classify_ui_tree', 'android', 60,
    '{"id":"classify_ui_tree","name":"Classify UI tree","source":"workflow_runtime","category":"observation","description":"Classify a UI tree using only workflow-supplied state definitions.","risk":"low","requiresDevice":true,"sideEffects":["observation"],"inputSchema":{"required":["states"],"optional":["treeVariable"]},"outputSchema":{"produces":["screenState","classifier_output"]},"policy":{"readOnly":true,"mutating":false,"destructive":false,"externalAction":false},"availability":{"directWs":false,"edgeWorkflow":true,"serverRuntime":true},"notes":[]}'::jsonb),
  ('tool_catalog', 'extract_ui_values', 'android', 55,
    '{"id":"extract_ui_values","name":"Extract UI values","source":"workflow_runtime","category":"observation","description":"Extract values declared by the selected Goal Contract.","risk":"low","requiresDevice":true,"sideEffects":["observation"],"inputSchema":{"required":["bindings"],"optional":["treeVariable"]},"outputSchema":{"produces":["bound_values"]},"policy":{"readOnly":true,"mutating":false,"destructive":false,"externalAction":false},"availability":{"directWs":false,"edgeWorkflow":true,"serverRuntime":true},"notes":[]}'::jsonb),
  ('tool_catalog', 'wait_for_idle', 'android', 50,
    '{"id":"wait_for_idle","name":"Wait for idle","source":"device_job","category":"workflow","description":"Wait for a declared UI settling interval.","risk":"low","requiresDevice":true,"sideEffects":[],"inputSchema":{"required":[],"optional":["timeoutMs"]},"outputSchema":{"produces":["wait_status"]},"policy":{"readOnly":true,"mutating":false,"destructive":false,"externalAction":false},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb),
  ('tool_catalog', 'screenshot', 'android', 45,
    '{"id":"screenshot","name":"Capture screenshot","source":"device_job","category":"observation","description":"Capture visual evidence when required by the Goal Contract.","risk":"low","requiresDevice":true,"sideEffects":["sensitive_screen_capture"],"inputSchema":{"required":[],"optional":["quality"]},"outputSchema":{"produces":["image_artifact"]},"policy":{"readOnly":true,"mutating":false,"destructive":false,"externalAction":false},"availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},"notes":[]}'::jsonb)
ON CONFLICT (namespace, entry_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  priority = EXCLUDED.priority,
  payload = EXCLUDED.payload,
  status = 'active',
  updated_at = NOW();

INSERT INTO app_runtime_profiles (
  app_id,
  app_name,
  package_name,
  profile_version,
  reset_recipe,
  mapping_recipe,
  safety_policy,
  default_device_id,
  metadata,
  active
)
VALUES (
  'com.android.chrome',
  'Chrome',
  'com.android.chrome',
  1,
  '[
    {"id":"open_app","type":"open_app","params":{"packageName":"{{packageName}}"}},
    {"id":"settle_home","type":"wait_for_idle","params":{"timeoutMs":2500},"delayAfterMs":750}
  ]'::jsonb,
  '[]'::jsonb,
  '{
    "mode":"read_only_navigation",
    "allowedActions":["open_app","intent_send","wait_for_idle","a11y_find_tap","scroll","press_key"],
    "blocked":["downloads","password_manager","settings_mutation"]
  }'::jsonb,
  NULL,
  '{"configuredBy":"migration_099","operationalSource":"postgresql"}'::jsonb,
  TRUE
)
ON CONFLICT (app_id) DO UPDATE SET
  app_name = EXCLUDED.app_name,
  package_name = EXCLUDED.package_name,
  profile_version = GREATEST(app_runtime_profiles.profile_version, EXCLUDED.profile_version),
  reset_recipe = EXCLUDED.reset_recipe,
  mapping_recipe = EXCLUDED.mapping_recipe,
  safety_policy = EXCLUDED.safety_policy,
  metadata = app_runtime_profiles.metadata || EXCLUDED.metadata,
  active = TRUE,
  updated_at = NOW();

INSERT INTO workflow_capabilities (
  capability_key,
  platform,
  description,
  aliases,
  safety_class,
  portability_scope,
  status,
  metadata
)
VALUES
(
  'device_unlock',
  'android',
  'Wake and unlock a compatible device.',
  ARRAY[
    'unlock device',
    'wake and unlock device',
    'deblocheaza telefonul',
    'deblochează telefonul'
  ]::TEXT[],
  'standard',
  'global',
  'active',
  jsonb_build_object(
    'configuredBy', 'migration_099',
    'goalContract', jsonb_build_object(
      'version', '1',
      'allowedEffects', jsonb_build_array('none'),
      'stages', jsonb_build_array(
        jsonb_build_object(
          'id', 'wake_device',
          'allowedActions', jsonb_build_array('screen_wake'),
          'allowedEffects', jsonb_build_array('none')
        ),
        jsonb_build_object(
          'id', 'unlock_device',
          'allowedActions', jsonb_build_array('unlock'),
          'allowedEffects', jsonb_build_array('none'),
          'after', jsonb_build_array('wake_device')
        )
      )
    )
  )
),
(
  'reddit_account_health_scan',
  'android',
  'Observe catalog-defined account and application health state without mutation.',
  ARRAY[
    'reddit account health scan',
    'check reddit account health',
    'verifica starea contului reddit',
    'verifică starea contului reddit'
  ]::TEXT[],
  'read_only',
  'global',
  'active',
  jsonb_build_object(
    'configuredBy', 'migration_099',
    'appId', 'reddit',
    'goalContract', jsonb_build_object(
      'version', '1',
      'allowedEffects', jsonb_build_array('none', 'navigation', 'observation'),
      'requiredOutputs', jsonb_build_array(
        'loggedIn',
        'homeFeedVisible',
        'searchSurfaceAvailable',
        'challengeDetected',
        'loginWallDetected',
        'accountSwitcherVisible',
        'observedUsername',
        'screenState',
        'error'
      ),
      'stages', jsonb_build_array(
        jsonb_build_object(
          'id', 'open_surface',
          'allowedActions', jsonb_build_array('screen_wake', 'unlock', 'open_app'),
          'allowedEffects', jsonb_build_array('none', 'navigation')
        ),
        jsonb_build_object(
          'id', 'observe_health',
          'allowedActions', jsonb_build_array('classify_ui_tree'),
          'allowedEffects', jsonb_build_array('observation'),
          'after', jsonb_build_array('open_surface'),
          'produces', jsonb_build_array(
            'loggedIn',
            'homeFeedVisible',
            'searchSurfaceAvailable',
            'challengeDetected',
            'loginWallDetected',
            'accountSwitcherVisible',
            'observedUsername',
            'screenState',
            'error'
          )
        )
      )
    )
  )
)
ON CONFLICT (capability_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  description = EXCLUDED.description,
  aliases = ARRAY(
    SELECT DISTINCT value
    FROM unnest(workflow_capabilities.aliases || EXCLUDED.aliases) AS value
    WHERE value IS NOT NULL AND BTRIM(value) <> ''
  ),
  safety_class = EXCLUDED.safety_class,
  portability_scope = EXCLUDED.portability_scope,
  status = EXCLUDED.status,
  metadata = workflow_capabilities.metadata || EXCLUDED.metadata,
  updated_at = NOW();

DO $$
BEGIN
  IF to_regclass('public.agency_workflow_definitions') IS NOT NULL THEN
    EXECUTE $update$
      UPDATE agency_workflow_definitions
      SET policy = COALESCE(policy, '{}'::jsonb) || jsonb_build_object(
            'reusable', promotion_state = 'limited_reuse',
            'requiredGateIds', jsonb_build_array(
              'compiler_knowledge_application',
              'limited_reuse_scope_match',
              'compiler_auto_use',
              'execution_path_change'
            ),
            'allowedStatuses', jsonb_build_array('active'),
            'allowedPromotionStates', jsonb_build_array('limited_reuse'),
            'minimumPromotionConfidence', 0.6,
            'requireScopeMatch', true,
            'resolutionScoring', jsonb_build_object(
              'exactKey', 100,
              'exactIntent', 50,
              'platform', 10,
              'termMatch', 12,
              'statusScores', jsonb_build_object(
                'active', 10,
                'draft', 2
              )
            )
          ),
          promotion_readiness = COALESCE(promotion_readiness, '{}'::jsonb) || jsonb_build_object(
            'safeToAutoApply',
            COALESCE((promotion_readiness->>'safeToAutoApply')::boolean, false)
          ),
          updated_at = NOW()
    $update$;
  END IF;
END
$$;

INSERT INTO system_prompts (key, content)
VALUES (
  'human_workflow_compiler_policy',
  $policy$
Compilation policy:
- Use only capability, App Map, runtime-profile and promoted knowledge supplied from PostgreSQL.
- Never infer an application package, selector, route, output field or workflow stage from server-side vocabulary.
- A condition step must provide check or expression and a non-empty if_true step array. Add if_false only when the catalog contract requires it.
- Keep safetyClass, action effects and Goal Contract stages consistent.
- type_text and set_focused_text are ui_input when the selected Goal Contract permits ui_input; they are not business mutations by primitive name alone.
- For navigation to an absolute http:// or https:// URI, use one intent_send action with android.intent.action.VIEW, the exact URI requested by the user, and the package from the selected runtime profile. Do not use address-bar selectors, a11y_find_tap, type_text, set_focused_text, press_key, or observe_and_transition unless matching promoted App Map evidence was supplied. Never invent a package, selector, verification target, or output.
- When absolute-URI navigation is the entire goal and no promoted verification evidence was supplied, emit exactly four action steps and no wait/condition/checkpoint/verification steps: screen_wake and unlock in a required prepare stage with effect none, open_app(packageName) in a later navigation stage, then intent_send({"action":"android.intent.action.VIEW","uri":"https://...","packageName":"..."}) in a final navigation stage. The contract allowedEffects is ["none","navigation"]; omit requiredOutputs and omit the outputSchema field entirely.
- For account-creation capabilities, use only stages, fields and authorized values declared by the selected catalog contract.
- If promoted knowledge is insufficient to cover a required stage or output, fail closed with MISSING_PROMOTED_KNOWLEDGE.
- When no catalog Goal Contract was retrieved, derive only Goal Contract v1 in this exact shape: {"version":"1","allowedEffects":["none","navigation"],"stages":[{"id":"stage_id","allowedActions":["primitive"],"allowedEffects":["none"],"after":["earlier_stage"]}],"requiredOutputs":["optionalOutput"]}. version, allowedEffects, stages[].id, and non-empty stages[].allowedActions are mandatory. outputSchema belongs to the workflow root, never inside goalContract.
- The derived contract must contain every effect used by an action, and each stage must allow every action/effect assigned to it. If a verification action is added, declare observation globally and in its stage. Do not invent requiredOutputs or outputSchema properties when the user did not request a returned value; any declared required output must have a real runtime producer.
- outputSchema is JSON Schema-shaped data: {"required":["name"],"properties":{"name":{"type":"string"}}}. Every goalContract.requiredOutputs entry must occur in required and properties.
- Every variable declared by a Goal Contract stage.produces must be emitted by an action in that stage through step.saveOutputAs, params.outputVariable, or a classify_ui_tree params.outputs key. A descriptive prompt or targetVariable does not produce a runtime binding.
- classify_ui_tree is deterministic and params.outputs must be an object keyed by produced variable name, never an array. Each value is a rule supplied by PostgreSQL/App Map knowledge and uses cases, regex, group, anyContains, allContains, noneContains, value, trueValue, falseValue, or default; never use prompt, responseFormat, targetVariable, or invented extraction semantics.
- observe_and_transition params.postcondition is a deterministic predicate object: {"action":"ui_tree_dump","params":{},"outputPath":"uiTree","operator":"contains_ci","expected":"catalog-supplied evidence"}. operator must be truthy, falsy, equals, not_equals, contains, contains_ci, not_contains, not_contains_ci, exists, or missing.
- Select a dynamic result only through a selector or binding produced by an earlier observation stage. A consumed variable must appear structurally as {"$bind":"variableName"} or {{variableName}} in that stage's params; the literal string "variableName" is not a binding. Never reuse an input-field selector as the result selector. If the supplied data cannot identify and verify the result, fail closed with MISSING_PROMOTED_KNOWLEDGE.
$policy$
)
ON CONFLICT (key) DO UPDATE SET
  content = EXCLUDED.content,
  updated_at = NOW();
