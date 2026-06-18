CREATE TABLE IF NOT EXISTS workflow_shortcuts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','draft')),
  priority INTEGER NOT NULL DEFAULT 100,
  intent_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  match_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_template JSONB NOT NULL,
  compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_shortcuts_active_platform_idx
  ON workflow_shortcuts(platform, status, priority);

CREATE TABLE IF NOT EXISTS human_workflow_compile_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key TEXT NOT NULL UNIQUE,
  device_id UUID NOT NULL,
  account_id UUID NOT NULL,
  intent TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','ready','failed','cancelled')),
  cache_key TEXT,
  source TEXT CHECK (source IN ('cache','shortcut','llm')),
  shortcut_id UUID REFERENCES workflow_shortcuts(id),
  error TEXT,
  result JSONB,
  llm_started_at TIMESTAMPTZ,
  llm_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS human_workflow_compile_jobs_status_idx
  ON human_workflow_compile_jobs(status, created_at);

INSERT INTO workflow_shortcuts
  (key, platform, name, description, priority, intent_patterns, match_config, workflow_template, metadata)
VALUES
  (
    'reddit_first_post_comments',
    'reddit',
    'Reddit first post comments opener',
    'Open Reddit and tap the comments button on the first visible post.',
    20,
    '[
      {"type":"contains_all","locale":"ro","terms":["reddit","prima postare","comentarii","apasa"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","prima postare","comantarii","apasa"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","primul post","comentarii","apasa"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","primul post","comantarii","apasa"]},
      {"type":"contains_all","terms":["reddit","first post","comments","tap"]}
    ]'::jsonb,
    '{"readOnlyOnly":true}'::jsonb,
    '{
      "id":"dashboard_human_reddit_first_post_comments_v1",
      "name":"Reddit first post comments opener",
      "platform":"reddit",
      "description":"Open Reddit and tap the comments button on the first visible post.",
      "version":"1.0.0",
      "defaultVerificationStrategy":"local_only",
      "dataRetentionDays":7,
      "steps":[
        {"id":"wake_screen","type":"action","action":"screen_wake","params":{}},
        {"id":"unlock_device","type":"action","action":"unlock","params":{}},
        {"id":"open_reddit","type":"action","action":"open_app","params":{"packageName":"com.reddit.frontpage"}},
        {"id":"settle_feed","type":"action","action":"wait_for_idle","params":{"timeoutMs":3000}},
        {"id":"tap_first_post_comments","type":"action","action":"tap","target":"post.comments","params":{"selectorName":"post.comments","bindingSource":"ui_tree_selector","ordinal":1}},
        {"id":"settle_comments","type":"action","action":"wait_for_idle","params":{"timeoutMs":2000}},
        {"id":"comments_opened","type":"checkpoint","reason":"Reddit first visible post comments opened from dashboard human workflow"}
      ]
    }'::jsonb,
    '{"seed":"038_human_workflow_shortcuts_async_compile"}'::jsonb
  ),
  (
    'askreddit_first_hot_read',
    'reddit',
    'AskReddit hot first item reader',
    'Open r/AskReddit hot feed and capture the first visible item for dashboard review.',
    30,
    '[
      {"type":"contains_all","terms":["askreddit","first post"]},
      {"type":"contains_all","locale":"ro","terms":["askreddit","primul post"]},
      {"type":"contains_all","terms":["reddit","browse"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","citeste"]}
    ]'::jsonb,
    '{"readOnlyOnly":true}'::jsonb,
    '{
      "id":"dashboard_human_reddit_askreddit_hot_first_item_v1",
      "name":"AskReddit hot first item reader",
      "platform":"reddit",
      "description":"Open r/AskReddit hot feed and capture the first visible item for dashboard review.",
      "version":"1.0.0",
      "defaultVerificationStrategy":"local_with_screenshot",
      "dataRetentionDays":7,
      "steps":[
        {"id":"open_askreddit_hot","type":"action","action":"open_app","params":{"packageName":"com.reddit.frontpage","uri":"https://www.reddit.com/r/AskReddit/hot/"}},
        {"id":"wait_for_reddit","type":"wait","condition":"app_launched","timeoutMs":10000},
        {"id":"settle_hot_feed","type":"action","action":"wait_for_idle","params":{"timeoutMs":3000}},
        {"id":"capture_visible_state","type":"action","action":"get_screen_state","params":{"scope":"askreddit_hot_first_visible_item"}},
        {"id":"dump_visible_content","type":"action","action":"ui_tree_dump","params":{"scope":"askreddit_hot_first_visible_item"}},
        {"id":"capture_visible_item","type":"action","action":"screenshot","params":{"quality":85}},
        {"id":"visible_item_ready","type":"checkpoint","reason":"AskReddit hot first visible item captured for reading"}
      ]
    }'::jsonb,
    '{"seed":"038_human_workflow_shortcuts_async_compile"}'::jsonb
  )
ON CONFLICT (key) DO UPDATE SET
  platform = EXCLUDED.platform,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  status = 'active',
  priority = EXCLUDED.priority,
  intent_patterns = EXCLUDED.intent_patterns,
  match_config = EXCLUDED.match_config,
  workflow_template = EXCLUDED.workflow_template,
  metadata = workflow_shortcuts.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO workflow_shortcuts
  (key, platform, name, description, priority, intent_patterns, match_config, workflow_template, metadata)
SELECT
  platform || '_open_app',
  platform,
  'Open ' || platform || ' app',
  'Open the app and wait briefly for the first screen to settle.',
  100,
  jsonb_build_array(
    jsonb_build_object('type', 'contains_all', 'terms', jsonb_build_array('open', platform)),
    jsonb_build_object('type', 'contains_all', 'terms', jsonb_build_array('launch', platform)),
    jsonb_build_object('type', 'contains_all', 'terms', jsonb_build_array('start', platform)),
    jsonb_build_object('type', 'contains_all', 'locale', 'ro', 'terms', jsonb_build_array('deschide', platform)),
    jsonb_build_object('type', 'contains_all', 'locale', 'ro', 'terms', jsonb_build_array('porneste', platform))
  ),
  jsonb_build_object(
    'readOnlyOnly', true,
    'rejectTerms', jsonb_build_array(
      'apasa',
      'buton',
      'capture',
      'citeste',
      'comment',
      'comentarii',
      'deruleaza',
      'fa screenshot',
      'first post',
      'intra pe',
      'notifications',
      'notificari',
      'postare',
      'prima postare',
      'read',
      'screenshot',
      'scroll',
      'tap'
    )
  ),
  jsonb_build_object(
    'id', 'dashboard_human_' || platform || '_open_app_v1',
    'name', 'Open ' || platform || ' app',
    'platform', platform,
    'description', 'Open the ' || platform || ' app and wait briefly for the first screen to settle.',
    'version', '1.0.0',
    'defaultVerificationStrategy', 'local_only',
    'dataRetentionDays', 7,
    'steps', jsonb_build_array(
      jsonb_build_object('id','wake_screen','type','action','action','screen_wake','params',jsonb_build_object()),
      jsonb_build_object('id','unlock_device','type','action','action','unlock','params',jsonb_build_object()),
      jsonb_build_object('id','open_app','type','action','action','open_app','params',jsonb_build_object('packageName', package_name)),
      jsonb_build_object('id','settle_app','type','action','action','wait_for_idle','params',jsonb_build_object('timeoutMs', 2000)),
      jsonb_build_object('id','app_opened','type','checkpoint','reason', platform || ' opened from dashboard human workflow')
    )
  ),
  '{"seed":"038_human_workflow_shortcuts_async_compile"}'::jsonb
FROM (VALUES
  ('instagram', 'com.instagram.android'),
  ('reddit', 'com.reddit.frontpage'),
  ('tiktok', 'com.zhiliaoapp.musically'),
  ('twitter', 'com.twitter.android')
) AS apps(platform, package_name)
ON CONFLICT (key) DO UPDATE SET
  platform = EXCLUDED.platform,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  status = 'active',
  priority = EXCLUDED.priority,
  intent_patterns = EXCLUDED.intent_patterns,
  match_config = EXCLUDED.match_config,
  workflow_template = EXCLUDED.workflow_template,
  metadata = workflow_shortcuts.metadata || EXCLUDED.metadata,
  updated_at = NOW();
