-- PostgreSQL-authoritative human workflow compiler control plane.
-- TypeScript is limited to orchestration, strict template rendering, schema
-- parsing, primitive execution and fail-closed mechanical validation.

CREATE OR REPLACE FUNCTION compiler_tokens(value TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT DISTINCT token
      FROM unnest(regexp_split_to_array(lower(value), '[^[:alnum:]_]+')) AS token
      WHERE length(token) >= 2
      ORDER BY token
    ),
    ARRAY[]::TEXT[]
  )
$$;

CREATE OR REPLACE FUNCTION resolve_human_workflow_platform(p_intent TEXT)
RETURNS TABLE (
  app_id TEXT,
  package_name TEXT,
  app_name TEXT,
  match_score INTEGER
)
LANGUAGE sql
STABLE
AS $$
  WITH candidates AS (
    SELECT
      profile.app_id,
      profile.package_name,
      profile.app_name,
      GREATEST(
        CASE WHEN position(lower(profile.app_id) IN lower(p_intent)) > 0 THEN length(profile.app_id) ELSE 0 END,
        CASE WHEN position(lower(profile.package_name) IN lower(p_intent)) > 0 THEN length(profile.package_name) ELSE 0 END,
        CASE WHEN position(lower(profile.app_name) IN lower(p_intent)) > 0 THEN length(profile.app_name) ELSE 0 END,
        COALESCE((
          SELECT max(length(alias))
          FROM jsonb_array_elements_text(COALESCE(profile.metadata->'compilerAliases', '[]'::jsonb)) alias
          WHERE position(lower(alias) IN lower(p_intent)) > 0
        ), 0)
      )::INTEGER AS match_score
    FROM app_runtime_profiles profile
    WHERE profile.active = TRUE
  )
  SELECT candidates.app_id, candidates.package_name, candidates.app_name, candidates.match_score
  FROM candidates
  WHERE candidates.match_score > 0
  ORDER BY candidates.match_score DESC, candidates.app_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION resolve_workflow_capabilities(
  p_intent TEXT,
  p_platform TEXT
)
RETURNS TABLE (
  capability_key TEXT,
  platform TEXT,
  description TEXT,
  aliases TEXT[],
  required_terms TEXT[],
  forbidden_terms TEXT[],
  safety_class TEXT,
  portability_scope TEXT,
  min_match_score DOUBLE PRECISION,
  ambiguity_margin DOUBLE PRECISION,
  metadata JSONB,
  updated_at TIMESTAMPTZ,
  score DOUBLE PRECISION,
  selected BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH input AS (
    SELECT compiler_tokens(p_intent) AS tokens
  ),
  descriptors AS (
    SELECT
      capability.*,
      descriptor.value AS descriptor,
      compiler_tokens(descriptor.value) AS descriptor_tokens,
      input.tokens AS query_tokens
    FROM workflow_capabilities capability
    CROSS JOIN input
    CROSS JOIN LATERAL unnest(
      ARRAY[capability.capability_key, COALESCE(capability.description, '')] || capability.aliases
    ) descriptor(value)
    WHERE capability.status = 'active'
      AND capability.portability_scope = 'global'
      AND (lower(capability.platform) = lower(p_platform) OR lower(capability.platform) = 'android')
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(capability.required_terms) term
        WHERE NOT compiler_tokens(term) <@ input.tokens
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(capability.forbidden_terms) term
        WHERE compiler_tokens(term) <@ input.tokens
      )
  ),
  scored_descriptors AS (
    SELECT
      descriptors.*,
      (
        SELECT count(*)::DOUBLE PRECISION
        FROM unnest(descriptors.query_tokens) token
        WHERE token = ANY(descriptors.descriptor_tokens)
      ) AS shared
    FROM descriptors
  ),
  ranked AS (
    SELECT
      scored_descriptors.capability_key,
      scored_descriptors.platform,
      scored_descriptors.description,
      scored_descriptors.aliases,
      scored_descriptors.required_terms,
      scored_descriptors.forbidden_terms,
      scored_descriptors.safety_class,
      scored_descriptors.portability_scope,
      scored_descriptors.min_match_score,
      scored_descriptors.ambiguity_margin,
      scored_descriptors.metadata,
      scored_descriptors.updated_at,
      max(
        CASE
          WHEN shared < 2 THEN 0
          ELSE
            2
            * (shared / GREATEST(cardinality(query_tokens), 1))
            * (shared / GREATEST(cardinality(descriptor_tokens), 1))
            / NULLIF(
                (shared / GREATEST(cardinality(query_tokens), 1))
                + (shared / GREATEST(cardinality(descriptor_tokens), 1)),
                0
              )
        END
      ) AS score
    FROM scored_descriptors
    GROUP BY
      scored_descriptors.capability_key,
      scored_descriptors.platform,
      scored_descriptors.description,
      scored_descriptors.aliases,
      scored_descriptors.required_terms,
      scored_descriptors.forbidden_terms,
      scored_descriptors.safety_class,
      scored_descriptors.portability_scope,
      scored_descriptors.min_match_score,
      scored_descriptors.ambiguity_margin,
      scored_descriptors.metadata,
      scored_descriptors.updated_at
  ),
  accepted AS (
    SELECT *
    FROM ranked
    WHERE ranked.score >= ranked.min_match_score
  ),
  ordered AS (
    SELECT
      accepted.*,
      row_number() OVER (ORDER BY accepted.score DESC, accepted.updated_at DESC) AS position,
      lead(accepted.score) OVER (ORDER BY accepted.score DESC, accepted.updated_at DESC) AS runner_up_score
    FROM accepted
  )
  SELECT
    ordered.capability_key,
    ordered.platform,
    ordered.description,
    ordered.aliases,
    ordered.required_terms,
    ordered.forbidden_terms,
    ordered.safety_class,
    ordered.portability_scope,
    ordered.min_match_score,
    ordered.ambiguity_margin,
    ordered.metadata,
    ordered.updated_at,
    ordered.score,
    (
      ordered.position = 1
      AND (
        ordered.runner_up_score IS NULL
        OR ordered.score - ordered.runner_up_score >= ordered.ambiguity_margin
      )
    ) AS selected
  FROM ordered
  ORDER BY ordered.position
$$;

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

INSERT INTO runtime_semantic_entries (
  namespace,
  entry_key,
  platform,
  priority,
  payload
)
VALUES (
  'compiler_control_plane',
  'human_workflow_v1',
  '*',
  100,
  '{
    "version":"2026-07-24-postgres-authoritative-v1",
    "missingCapabilityPolicy":"fail_closed",
    "normalizationPolicy":"strict_reject",
    "promptKeys":{
      "compile":"human_workflow_compile_template",
      "repair":"human_workflow_repair_template",
      "compileSystem":"human_workflow_compile_system",
      "repairSystem":"human_workflow_repair_system",
      "policy":"human_workflow_compiler_policy"
    },
    "llm":{
      "initialMaxTokens":4096,
      "repairMaxTokens":6144,
      "temperature":0,
      "disableThinking":true
    },
    "retrievalPolicy":{
      "maxContextArtifacts":4,
      "maxContextUiItems":10,
      "maxContextFailures":4,
      "maxRankedCapabilities":5,
      "maxArtifactRows":20,
      "maxFailedArtifactRows":50,
      "maxArtifactSteps":16,
      "artifactParamAllowlist":["action","contentDescription","key","packageName","resourceId","semanticId","target","uri"],
      "uiGraphSafetyAllowlist":["read_only","navigation"],
      "artifactSafetyAllowlist":{
        "read_only":["read_only"],
        "navigation":["read_only","navigation"],
        "standard":["read_only","navigation","standard"],
        "mutating":["read_only","navigation","standard","mutating"],
        "sensitive":["read_only","navigation","standard","mutating","sensitive"],
        "destructive":["read_only","navigation","standard","mutating","sensitive","destructive"]
      }
    },
    "safetyClassMap":{
      "read_only":"read_only",
      "navigation":"read_only",
      "standard":"standard",
      "mutating":"standard",
      "sensitive":"standard",
      "destructive":"destructive"
    }
  }'::jsonb
)
ON CONFLICT (namespace, entry_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  priority = EXCLUDED.priority,
  payload = EXCLUDED.payload,
  status = 'active',
  updated_at = NOW();

INSERT INTO system_prompts (key, content)
VALUES
(
  'human_workflow_compile_system',
  'You are a Phone Network workflow compiler. Return only valid WorkflowTemplate JSON. No reasoning.'
),
(
  'human_workflow_repair_system',
  'You are a Phone Network workflow compiler repairing a rejected plan. Return only complete valid WorkflowTemplate JSON. No reasoning.'
),
(
  'human_workflow_compile_template',
  $prompt$
Return JSON only. Generate one Phone Network WorkflowTemplate.
Goal: {{goal}}
Target context: {{targetContext}}
The selected PostgreSQL runtime profile is: {{runtimeProfile}}
The selected PostgreSQL capability and Goal Contract are: {{retrievalContext}}
The PostgreSQL primitive catalog is: {{toolCatalog}}
The PostgreSQL compiler policy is:
{{compilerPolicy}}

Mandatory rules:
- Return the WorkflowTemplate itself as the top-level JSON object. Never wrap it in {"workflow": ...}.
- The top-level object must contain id, name, platform, description, version, runtimeContract, safetyClass, goalContract, steps, defaultVerificationStrategy and dataRetentionDays.
- steps must be one flat, non-empty top-level array. Do not emit a top-level stages array and do not nest executable steps inside stage objects.
- Each executable action belongs directly in top-level steps as {"type":"action","id":"...","action":"...","params":{},"effect":"...","goalStage":"..."}.
- stages exist only inside the copied goalContract; goalContract stages describe policy and never contain executable steps.
- Copy primitive parameter names exactly from inputSchema. For intent_send the absolute target is params.uri; never emit params.data.
- Copy the selected Goal Contract exactly. Never derive, expand or replace it.
- Set workflow.platform exactly to the selected runtime profile appId.
- Use only actions present in the supplied primitive catalog and only packages, selectors, routes, states, transitions and outputs supplied by PostgreSQL.
- Every action must declare effect and goalStage exactly as allowed by the selected Goal Contract.
- Return all schema-required WorkflowTemplate fields. runtimeContract is edge-workflow/v2.
- defaultVerificationStrategy is local_only and dataRetentionDays is 7.
- Do not emit workflow.intent.
- Do not add preparation, verification, waits, outputs or fallbacks unless the selected contract or promoted knowledge explicitly requires them.
- If the supplied PostgreSQL data cannot cover the goal, return {"compilerRefusal":{"code":"MISSING_PROMOTED_KNOWLEDGE"}} instead of inventing data.
$prompt$
),
(
  'human_workflow_repair_template',
  $prompt$
{{compilePrompt}}

CORRECTIVE COMPILATION REQUIRED.
Mechanical rejection reason: {{reason}}
Return one complete replacement WorkflowTemplate JSON.
Return the WorkflowTemplate itself as the top-level object, never {"workflow": ...}. Executable actions must be in one flat top-level steps array; stages may appear only inside the copied goalContract and must never contain executable steps. Copy primitive parameter names exactly; intent_send uses params.uri and never params.data.
Use only the PostgreSQL contract, runtime profile, tool catalog and promoted knowledge already present above.
Do not normalize, derive or add semantics. If the supplied data is insufficient, return {"compilerRefusal":{"code":"MISSING_PROMOTED_KNOWLEDGE"}}.
Rejected candidate: {{rejectedWorkflow}}
$prompt$
)
ON CONFLICT (key) DO UPDATE SET
  content = EXCLUDED.content,
  updated_at = NOW();

UPDATE app_runtime_profiles
SET metadata = metadata || '{"compilerAliases":["chrome","browserul chrome","browser chrome"]}'::jsonb,
    updated_at = NOW()
WHERE app_id = 'com.android.chrome';

INSERT INTO workflow_capabilities (
  capability_key,
  platform,
  description,
  aliases,
  required_terms,
  forbidden_terms,
  safety_class,
  portability_scope,
  status,
  min_match_score,
  ambiguity_margin,
  metadata
)
VALUES (
  'web_open_absolute_uri',
  'android',
  'Navigate the PostgreSQL-selected browser runtime directly to an absolute URI requested by the user.',
  ARRAY[
    'deschide browserul chrome si mergi pe google.com',
    'open chrome browser and go to google.com',
    'open browser and navigate to url',
    'deschide browserul si mergi la url'
  ]::TEXT[],
  ARRAY[]::TEXT[],
  ARRAY[]::TEXT[],
  'navigation',
  'global',
  'active',
  0.62,
  0.12,
  jsonb_build_object(
    'configuredBy', 'migration_100',
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
  )
)
ON CONFLICT (capability_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  description = EXCLUDED.description,
  aliases = EXCLUDED.aliases,
  required_terms = EXCLUDED.required_terms,
  forbidden_terms = EXCLUDED.forbidden_terms,
  safety_class = EXCLUDED.safety_class,
  portability_scope = EXCLUDED.portability_scope,
  status = EXCLUDED.status,
  min_match_score = EXCLUDED.min_match_score,
  ambiguity_margin = EXCLUDED.ambiguity_margin,
  metadata = workflow_capabilities.metadata || EXCLUDED.metadata,
  updated_at = NOW();

-- The compiler must never derive a Goal Contract when catalog resolution
-- failed. Replace the old permissive policy with explicit fail-closed text.
UPDATE system_prompts
SET content = regexp_replace(
      regexp_replace(
        content,
        '- When absolute-URI navigation is the entire goal[^\n]*',
        '- When absolute-URI navigation is the entire goal and no promoted verification evidence was supplied, emit exactly three action steps and no wait/condition/checkpoint/verification steps: screen_wake and unlock in the required prepare stage with effect none, then intent_send({"action":"android.intent.action.VIEW","uri":"https://...","packageName":"..."}) in the navigation stage. Do not emit open_app: some valid browser runtimes expose VIEW intents without a launcher intent. The contract allowedEffects is ["none","navigation"]; omit requiredOutputs and omit the outputSchema field entirely.',
        'g'
      ),
      '- When no catalog Goal Contract was retrieved,[^\n]*',
      '- When no catalog Goal Contract was retrieved, fail closed with MISSING_CAPABILITY_CONTRACT. Never derive a Goal Contract.',
      'g'
    ),
    updated_at = NOW()
WHERE key = 'human_workflow_compiler_policy';

-- Old dashboard compiler artifacts were produced under an engine that could
-- inject or derive semantics in TypeScript. They must not cross the strict
-- PostgreSQL-authoritative compiler version boundary.
UPDATE generated_workflow_plan_cache
SET artifact_state = 'quarantined',
    source_metadata = source_metadata || jsonb_build_object(
      'quarantineReason', 'compiler_control_plane_version_mismatch',
      'quarantinedBy', 'migration_100'
    ),
    updated_at = NOW()
WHERE source_metadata->>'source' = 'dashboard_human'
  AND COALESCE(source_metadata->>'compilerCacheVersion', '') <> '2026-07-24-postgres-authoritative-v1';
