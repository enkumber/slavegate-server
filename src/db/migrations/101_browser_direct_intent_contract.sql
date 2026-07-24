-- Make absolute-URI browser navigation use the primitive proven on-device:
-- an explicit VIEW intent. Some browser installations expose VIEW intent
-- filters but no launcher intent, so open_app is not a valid prerequisite.

INSERT INTO runtime_semantic_entries (
  namespace,
  entry_key,
  platform,
  priority,
  payload
)
VALUES (
  'tool_catalog',
  'intent_send',
  'android',
  89,
  '{
    "id":"intent_send",
    "name":"Send Android intent",
    "source":"device_job",
    "category":"navigation",
    "description":"Send an Android intent whose action, uri and package are supplied by the selected PostgreSQL capability and runtime profile. The absolute target URL must be stored in params.uri; params.data is not part of this primitive contract.",
    "risk":"medium",
    "requiresDevice":true,
    "sideEffects":["foreground_app_change","external_navigation"],
    "inputSchema":{"required":["action","uri","packageName"],"optional":["type","extras","flags"]},
    "outputSchema":{"produces":["intent_status"]},
    "policy":{"readOnly":false,"mutating":true,"destructive":false,"externalAction":true},
    "availability":{"directWs":true,"edgeWorkflow":true,"serverRuntime":false},
    "notes":[]
  }'::jsonb
)
ON CONFLICT (namespace, entry_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  priority = EXCLUDED.priority,
  payload = EXCLUDED.payload,
  status = 'active',
  updated_at = NOW();

UPDATE workflow_capabilities
SET description = 'Navigate the PostgreSQL-selected browser runtime directly to an absolute URI requested by the user.',
    metadata = metadata || jsonb_build_object(
      'configuredBy', 'migration_101',
      'appId', 'com.android.chrome',
      'goalContract', jsonb_build_object(
        'version', '1',
        'allowedEffects', jsonb_build_array('none', 'navigation'),
        'stages', jsonb_build_array(
          jsonb_build_object(
            'id', 'prepare_device',
            'allowedActions', jsonb_build_array('screen_wake', 'unlock'),
            'allowedEffects', jsonb_build_array('none')
          ),
          jsonb_build_object(
            'id', 'navigate_uri',
            'allowedActions', jsonb_build_array('intent_send'),
            'allowedEffects', jsonb_build_array('navigation'),
            'after', jsonb_build_array('prepare_device')
          )
        )
      )
    ),
    updated_at = NOW()
WHERE capability_key = 'web_open_absolute_uri';

UPDATE system_prompts
SET content = regexp_replace(
      content,
      '- When absolute-URI navigation is the entire goal[^\n]*',
      '- When absolute-URI navigation is the entire goal and no promoted verification evidence was supplied, emit exactly three action steps and no wait/condition/checkpoint/verification steps: screen_wake and unlock in the required prepare stage with effect none, then intent_send({"action":"android.intent.action.VIEW","uri":"https://...","packageName":"..."}) in the navigation stage. Do not emit open_app: some valid browser runtimes expose VIEW intents without a launcher intent. The contract allowedEffects is ["none","navigation"]; omit requiredOutputs and omit the outputSchema field entirely.',
      'g'
    ),
    updated_at = NOW()
WHERE key = 'human_workflow_compiler_policy';

-- Force affected dashboard requests to compile against the corrected DB
-- contract. Keep successful direct-intent artifacts available.
UPDATE generated_workflow_plan_cache
SET artifact_state = 'quarantined',
    source_metadata = source_metadata || jsonb_build_object(
      'quarantineReason', 'browser_launcher_intent_not_required',
      'quarantinedBy', 'migration_101'
    ),
    updated_at = NOW()
WHERE source_metadata->>'source' = 'dashboard_human'
  AND (
    source_metadata->>'capabilityKey' = 'web_open_absolute_uri'
    OR request_key = 'ee56c40761fdbace53bd6dc3'
  )
  AND jsonb_path_exists(workflow, '$.steps[*] ? (@.action == "open_app")');
