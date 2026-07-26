-- Migration: Vision Layer tables (P2.1)
-- Checkpoints pentru session recovery + skill coords cache

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. EXECUTION CHECKPOINTS — session state recovery
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS execution_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL,
    task_id UUID NOT NULL,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    
    phase VARCHAR(50) NOT NULL,  -- 'warm_up', 'search', 'decision_loop', 'cool_down', 'blocked', 'error'
    state JSONB NOT NULL DEFAULT '{}',  -- {"evaluated": N, "matched": N, "last_target": "@user", "scroll_position": N, "partial_results": [...]}
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    
    CONSTRAINT uq_checkpoint_task_device UNIQUE(task_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON execution_checkpoints(task_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_device ON execution_checkpoints(device_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON execution_checkpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_expires ON execution_checkpoints(expires_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_phase_device
ON execution_checkpoints(phase, device_id);

-- Auto-cleanup expired checkpoints (optional cron job sau pg_cron)
COMMENT ON TABLE execution_checkpoints IS 'Session state recovery for interrupted workflows. Expires after 24h.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. SKILL DEFINITIONS — master button/screen mappings per platform
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS skill_definitions (
    id VARCHAR(50) PRIMARY KEY,  -- 'instagram', 'tiktok', 'facebook'
    platform VARCHAR(50) NOT NULL,
    app_version VARCHAR(20),
    
    selectors JSONB NOT NULL DEFAULT '{}',  -- {"key": {"selector": "resource-id", "hint": "description"}, ...}
    
    navigation_map JSONB NOT NULL DEFAULT '{}',  -- {"screen": {"indicators": [...], "transitions": {"target": "action"}}, ...}
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE skill_definitions IS 'Master platform skill definitions. Shared across all devices.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. SKILL COORDS CACHE — learned coordinates per device
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS skill_coords_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id VARCHAR(50) NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    
    screen_width INT NOT NULL,
    screen_height INT NOT NULL,
    
    coords JSONB NOT NULL DEFAULT '{}',  -- {"key": {"x": N, "y": N, "confidence": 0.0-1.0, "learned_at": "ISO8601"}, ...}
    
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_skill_device UNIQUE(skill_id, device_id)
);

-- idx_skill_cache_skill removed: redundant with UNIQUE(skill_id, device_id)
CREATE INDEX IF NOT EXISTS idx_skill_cache_device ON skill_coords_cache(device_id);
CREATE INDEX IF NOT EXISTS idx_skill_cache_resolution ON skill_coords_cache(screen_width, screen_height);

COMMENT ON TABLE skill_coords_cache IS 'Learned UI coordinates per device. Synced between devices with same resolution.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. HELPER FUNCTION — merge coords keeping highest confidence
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION merge_coords_keep_highest_confidence(
    existing JSONB,
    incoming JSONB
) RETURNS JSONB AS $$
DECLARE
    result JSONB := existing;
    key TEXT;
    incoming_val JSONB;
    existing_conf FLOAT;
    incoming_conf FLOAT;
BEGIN
    FOR key, incoming_val IN SELECT * FROM jsonb_each(incoming)
    LOOP
        IF result ? key THEN
            existing_conf := COALESCE((result -> key ->> 'confidence')::FLOAT, 0);
            incoming_conf := COALESCE((incoming_val ->> 'confidence')::FLOAT, 0);
            IF incoming_conf > existing_conf THEN
                result := jsonb_set(result, ARRAY[key], incoming_val);
            END IF;
        ELSE
            result := jsonb_set(result, ARRAY[key], incoming_val);
        END IF;
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION merge_coords_keep_highest_confidence IS 'Merges coord JSONBs, keeping entry with highest confidence per key.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. SEED DATA — Instagram skill definition (starter)
-- ═══════════════════════════════════════════════════════════════════════════

-- NOTE: selectors are best-effort for ~v330. VLM will learn and update coords_cache with actual values.
INSERT INTO skill_definitions (id, platform, app_version, selectors, navigation_map)
VALUES (
    'instagram',
    'instagram',
    '330.0.0',
    '{
        "nav.home": {"selector": "com.instagram.android:id/feed_tab", "hint": "Home feed tab"},
        "nav.search": {"selector": "com.instagram.android:id/search_tab", "hint": "Search/Explore tab"},
        "nav.reels": {"selector": "com.instagram.android:id/clips_tab", "hint": "Reels tab"},
        "nav.profile": {"selector": "com.instagram.android:id/profile_tab", "hint": "Profile tab"},
        "post.like": {"selector": "com.instagram.android:id/row_feed_button_like", "hint": "Like button heart"},
        "post.comment": {"selector": "com.instagram.android:id/row_feed_button_comment", "hint": "Comment bubble"},
        "post.share": {"selector": "com.instagram.android:id/row_feed_button_share", "hint": "Share/Send icon"},
        "profile.follow": {"selector": "com.instagram.android:id/profile_header_follow_button", "hint": "Follow button on profile"},
        "profile.message": {"selector": "com.instagram.android:id/profile_header_message_button", "hint": "Message button"},
        "search.input": {"selector": "com.instagram.android:id/action_bar_search_edit_text", "hint": "Search text field"}
    }'::jsonb,
    '{
        "home": {"indicators": ["feed_tab_selected", "story_tray"], "transitions": {"search": "nav.search", "profile": "nav.profile"}},
        "search": {"indicators": ["search_tab_selected", "explore_grid"], "transitions": {"home": "nav.home"}},
        "profile": {"indicators": ["profile_tab_selected", "followers_count"], "transitions": {"home": "nav.home"}},
        "post_detail": {"indicators": ["like_button", "comment_input"], "transitions": {"back": "PRESS_BACK"}}
    }'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
    app_version = EXCLUDED.app_version,
    selectors = EXCLUDED.selectors,
    navigation_map = EXCLUDED.navigation_map,
    updated_at = NOW();

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. TRIGGER — auto-update updated_at on execution_checkpoints
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_checkpoints_updated_at
BEFORE UPDATE ON execution_checkpoints
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
