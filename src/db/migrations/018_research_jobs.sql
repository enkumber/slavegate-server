-- Migration: Research Jobs for Marketer Automation
-- Marketer generates research jobs → DB → Kraken/Hydra executes at night → results back to DB

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RESEARCH JOBS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS research_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type      TEXT NOT NULL CHECK (job_type IN ('research_profile', 'research_hashtag', 'research_followers')),
    input         JSONB NOT NULL,        -- {username: "x"} or {hashtag: "y", limit: 50}
    output        JSONB,                  -- results when completed
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'running', 'completed', 'failed')),
    priority      INT DEFAULT 0,          -- 0=low (research), 10=normal, 20=high
    device_id     UUID REFERENCES devices(id) ON DELETE SET NULL,
    error         TEXT,
    expires_at    TIMESTAMPTZ,            -- cache validity (default: created_at + 7 days)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scheduled_at  TIMESTAMPTZ,            -- when Kraken scheduled it
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ
);

COMMENT ON TABLE research_jobs IS 'Research jobs queue for Marketer automation. Executed by Kraken/Hydra during night window (01:00-05:00).';

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Fast lookup by status (for Kraken job polling)
CREATE INDEX IF NOT EXISTS idx_research_jobs_status ON research_jobs(status);

-- Fast lookup for cached results (completed jobs by type + input)
CREATE INDEX IF NOT EXISTS idx_research_jobs_type_input ON research_jobs(job_type, input) 
    WHERE status = 'completed';

-- Priority ordering for job scheduling
CREATE INDEX IF NOT EXISTS idx_research_jobs_pending_priority ON research_jobs(priority DESC, created_at ASC)
    WHERE status = 'pending';

-- Device assignment tracking
CREATE INDEX IF NOT EXISTS idx_research_jobs_device ON research_jobs(device_id)
    WHERE status IN ('scheduled', 'running');

-- Expired cache cleanup
CREATE INDEX IF NOT EXISTS idx_research_jobs_expires ON research_jobs(expires_at)
    WHERE status = 'completed';

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTION: Set default expires_at on insert
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_research_job_expires_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.expires_at IS NULL THEN
        NEW.expires_at := NEW.created_at + INTERVAL '7 days';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_research_jobs_set_expires
BEFORE INSERT ON research_jobs
FOR EACH ROW EXECUTE FUNCTION set_research_job_expires_at();

COMMIT;
