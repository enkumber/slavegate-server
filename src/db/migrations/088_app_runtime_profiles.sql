-- Database-owned application runtime profiles and safe mapping recipes.
-- Runtime code remains app-agnostic; deployment seeds only bootstrap the
-- initial profile. PostgreSQL becomes the operational source of truth.

CREATE TABLE IF NOT EXISTS app_runtime_profiles (
  app_id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  package_name TEXT NOT NULL UNIQUE,
  profile_version INT NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  reset_recipe JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapping_recipe JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(reset_recipe) = 'array'),
  CHECK (jsonb_typeof(mapping_recipe) = 'array'),
  CHECK (jsonb_typeof(safety_policy) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_app_runtime_profiles_active
  ON app_runtime_profiles(active, updated_at DESC);

INSERT INTO app_runtime_profiles (
  app_id,
  app_name,
  package_name,
  profile_version,
  reset_recipe,
  mapping_recipe,
  safety_policy,
  default_device_id,
  metadata
)
VALUES (
  'com.reddit.frontpage',
  'Reddit',
  'com.reddit.frontpage',
  1,
  '[
    {"id":"open_app","type":"open_app","params":{"packageName":"{{packageName}}"}},
    {"id":"canonical_home","type":"intent_send","params":{"action":"android.intent.action.VIEW","uri":"https://www.reddit.com/","packageName":"{{packageName}}"}},
    {"id":"settle_home","type":"wait_for_idle","params":{"timeoutMs":2500},"delayAfterMs":1500}
  ]'::jsonb,
  '[
    {"id":"home","type":"capture","stateKey":"reddit_home_feed","name":"Reddit home/feed"},
    {"id":"open_search","type":"a11y_find_tap","params":{"resourceId":"main_top_app_bar_search"},"optional":true,"transition":{"sourceStateKey":"reddit_home_feed","targetStateKey":"reddit_search_entry","elementKey":"main_top_app_bar_search"}},
    {"id":"settle_search_entry","type":"wait_for_idle","params":{"timeoutMs":2500},"delayAfterMs":750,"optional":true,"dependsOn":"open_search"},
    {"id":"search_entry","type":"capture","stateKey":"reddit_search_entry","name":"Reddit search entry","optional":true,"dependsOn":"open_search"},
    {"id":"open_askreddit","type":"intent_send","params":{"action":"android.intent.action.VIEW","uri":"https://www.reddit.com/r/AskReddit/","packageName":"{{packageName}}"}},
    {"id":"settle_askreddit","type":"wait_for_idle","params":{"timeoutMs":2500},"delayAfterMs":750},
    {"id":"askreddit_header","type":"capture","stateKey":"askreddit_header","name":"r/AskReddit header/community page"},
    {"id":"scroll_askreddit","type":"scroll","params":{"direction":"down","distancePx":900,"durationMs":450}},
    {"id":"settle_askreddit_scroll","type":"wait_for_idle","params":{"timeoutMs":2500},"delayAfterMs":750},
    {"id":"askreddit_feed_after_scroll","type":"capture","stateKey":"askreddit_feed_after_scroll","name":"r/AskReddit feed after scroll"},
    {"id":"open_search_surface","type":"intent_send","params":{"action":"android.intent.action.VIEW","uri":"https://www.reddit.com/search/?q=AskReddit","packageName":"{{packageName}}"}},
    {"id":"settle_search_surface","type":"wait_for_idle","params":{"timeoutMs":2500},"delayAfterMs":750},
    {"id":"search_surface","type":"capture","stateKey":"reddit_search_surface","name":"Reddit search surface"},
    {"id":"open_post_detail","type":"intent_send","params":{"action":"android.intent.action.VIEW","uri":"{{input.postUri}}","packageName":"{{packageName}}"},"optional":true,"whenInput":"postUri"},
    {"id":"settle_post_detail","type":"wait_for_idle","params":{"timeoutMs":2500},"delayAfterMs":750,"optional":true,"dependsOn":"open_post_detail"},
    {"id":"post_detail","type":"capture","stateKey":"reddit_post_detail","name":"Reddit post detail","optional":true,"dependsOn":"open_post_detail"}
  ]'::jsonb,
  '{
    "mode":"read_only_navigation",
    "allowedActions":["open_app","intent_send","wait_for_idle","a11y_find_tap","scroll"],
    "allowedUriHosts":["reddit.com","www.reddit.com"],
    "blocked":["vote","comment","join","login","settings","profile_mutation"]
  }'::jsonb,
  NULL,
  '{"seed":"088_app_runtime_profiles.sql","operationalSource":"postgresql"}'::jsonb
)
ON CONFLICT (app_id) DO NOTHING;
