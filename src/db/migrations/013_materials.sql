-- Migration 013: Materials table + posts.material_id
-- Sincronizează schema cu Tactician

-- ═══════════════════════════════════════════════════════════════════════════════
-- MATERIALS — Media assets pentru posts
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS materials (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        REFERENCES accounts(id) ON DELETE CASCADE,
  type            TEXT        NOT NULL,
  url             TEXT        NOT NULL,
  thumbnail_url   TEXT,
  filename        TEXT,
  size_bytes      BIGINT,
  duration_sec    INTEGER,    -- pentru video/reel
  width           INTEGER,
  height          INTEGER,
  metadata        JSONB       DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_materials_account ON materials(account_id);
CREATE INDEX IF NOT EXISTS idx_materials_type ON materials(type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Adaug material_id la posts
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE posts 
  ADD COLUMN IF NOT EXISTS material_id UUID REFERENCES materials(id) ON DELETE SET NULL;

ALTER TABLE posts 
  ADD COLUMN IF NOT EXISTS type TEXT;

ALTER TABLE posts 
  ADD COLUMN IF NOT EXISTS caption TEXT;

ALTER TABLE posts 
  ADD COLUMN IF NOT EXISTS hashtags TEXT[];

ALTER TABLE posts 
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

ALTER TABLE posts 
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_material ON posts(material_id) WHERE material_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Migrează date existente din content JSONB (dacă există)
-- ═══════════════════════════════════════════════════════════════════════════════

UPDATE posts 
SET 
  caption = content->>'caption',
  hashtags = ARRAY(SELECT jsonb_array_elements_text(content->'hashtags'))
WHERE content IS NOT NULL AND content != '{}'::jsonb;

COMMENT ON TABLE materials IS 'Media assets pentru postări (foto/video/reel/story)';
COMMENT ON COLUMN posts.material_id IS 'Referință la material-ul asociat postării';
