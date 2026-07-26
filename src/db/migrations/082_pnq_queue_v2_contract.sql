-- PNQ-003 Phase 2 Queue v2 persistence contract.
-- Defines the PostgreSQL-authoritative schema and contract functions only.
-- No dispatcher/runtime cutover is performed by this migration.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS pnq_nodes (
  id                 UUID PRIMARY KEY,
  node_key           TEXT NOT NULL,
  lifecycle_key      TEXT,
  status             TEXT NOT NULL,
  next_node_seq      BIGINT NOT NULL DEFAULT 1,
  connection_epoch   BIGINT NOT NULL DEFAULT 0,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pnq_nodes_node_key_unique UNIQUE (node_key),
  CONSTRAINT pnq_nodes_next_node_seq_check CHECK (next_node_seq >= 1),
  CONSTRAINT pnq_nodes_connection_epoch_check CHECK (connection_epoch >= 0)
);

CREATE TABLE IF NOT EXISTS pnq_jobs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id                    UUID NOT NULL REFERENCES pnq_nodes(id) ON DELETE RESTRICT,
  node_seq                   BIGINT NOT NULL,
  request_key                TEXT NOT NULL,
  request_payload            JSONB NOT NULL,
  lifecycle_key              TEXT,
  status                     TEXT NOT NULL,
  job_version                BIGINT NOT NULL DEFAULT 1,
  dispatch_generation        BIGINT NOT NULL DEFAULT 0,
  execution_id               UUID,
  claimed_connection_epoch   BIGINT,
  queue_deadline_at          TIMESTAMPTZ NOT NULL,
  dispatch_deadline_at       TIMESTAMPTZ NOT NULL,
  execution_deadline_at      TIMESTAMPTZ NOT NULL,
  result_deadline_at         TIMESTAMPTZ NOT NULL,
  available_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatch_started_at        TIMESTAMPTZ,
  execution_started_at       TIMESTAMPTZ,
  terminal_at                TIMESTAMPTZ,
  terminal_reason            TEXT,
  result_payload             JSONB,
  last_error                 TEXT,
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pnq_jobs_node_seq_unique UNIQUE (node_id, node_seq),
  CONSTRAINT pnq_jobs_request_key_unique UNIQUE (node_id, request_key),
  CONSTRAINT pnq_jobs_execution_id_unique UNIQUE (execution_id),
  CONSTRAINT pnq_jobs_job_version_check CHECK (job_version >= 1),
  CONSTRAINT pnq_jobs_dispatch_generation_check CHECK (dispatch_generation >= 0),
  CONSTRAINT pnq_jobs_claimed_connection_epoch_check CHECK (
    claimed_connection_epoch IS NULL OR claimed_connection_epoch >= 0
  ),
  CONSTRAINT pnq_jobs_execution_id_required_check CHECK (
    execution_started_at IS NULL OR execution_id IS NOT NULL
  ),
  CONSTRAINT pnq_jobs_deadline_order_check CHECK (
    queue_deadline_at < dispatch_deadline_at
    AND dispatch_deadline_at < execution_deadline_at
    AND execution_deadline_at < result_deadline_at
  )
);

CREATE INDEX IF NOT EXISTS pnq_jobs_fifo_idx
  ON pnq_jobs(node_id, status, node_seq);

DROP INDEX IF EXISTS pnq_jobs_one_active_per_node_idx;

CREATE INDEX IF NOT EXISTS pnq_jobs_recovery_idx
  ON pnq_jobs(status, updated_at, result_deadline_at);

CREATE INDEX IF NOT EXISTS pnq_jobs_terminal_idx
  ON pnq_jobs(node_id, terminal_at DESC)
  WHERE terminal_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS pnq_resolution_audit (
  id                    BIGSERIAL PRIMARY KEY,
  job_id                UUID REFERENCES pnq_jobs(id) ON DELETE SET NULL,
  node_id               UUID REFERENCES pnq_nodes(id) ON DELETE SET NULL,
  event_type            TEXT NOT NULL,
  decision              TEXT NOT NULL,
  observed_epoch        BIGINT,
  expected_epoch        BIGINT,
  observed_job_version  BIGINT,
  expected_job_version  BIGINT,
  observed_generation   BIGINT,
  expected_generation   BIGINT,
  execution_id          UUID,
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor                 TEXT NOT NULL DEFAULT 'pnq-v2-contract',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pnq_resolution_audit_event_type_check CHECK (
    event_type IN (
      'enqueue_idempotent_replay',
      'payload_conflict',
      'epoch_rejected',
      'cas_lost',
      'stale_result',
      'late_result',
      'result_mismatch',
      'recovery_required',
      'marked_stuck',
      'explicit_resolution'
    )
  ),
  CONSTRAINT pnq_resolution_audit_decision_check CHECK (
    decision IN ('ignored', 'rejected', 'stuck', 'resolved', 'requires_recovery')
  )
);

CREATE INDEX IF NOT EXISTS pnq_resolution_audit_job_idx
  ON pnq_resolution_audit(job_id, created_at);

CREATE INDEX IF NOT EXISTS pnq_resolution_audit_node_idx
  ON pnq_resolution_audit(node_id, created_at);

CREATE OR REPLACE FUNCTION pnq_resolution_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'pnq_resolution_audit is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pnq_resolution_audit_no_update ON pnq_resolution_audit;
CREATE TRIGGER pnq_resolution_audit_no_update
  BEFORE UPDATE ON pnq_resolution_audit
  FOR EACH ROW EXECUTE FUNCTION pnq_resolution_audit_append_only();

DROP TRIGGER IF EXISTS pnq_resolution_audit_no_delete ON pnq_resolution_audit;
CREATE TRIGGER pnq_resolution_audit_no_delete
  BEFORE DELETE ON pnq_resolution_audit
  FOR EACH ROW EXECUTE FUNCTION pnq_resolution_audit_append_only();

CREATE OR REPLACE FUNCTION pnq_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pnq_nodes_touch_updated_at ON pnq_nodes;
CREATE TRIGGER pnq_nodes_touch_updated_at
  BEFORE UPDATE ON pnq_nodes
  FOR EACH ROW EXECUTE FUNCTION pnq_touch_updated_at();

DROP TRIGGER IF EXISTS pnq_jobs_touch_updated_at ON pnq_jobs;
CREATE TRIGGER pnq_jobs_touch_updated_at
  BEFORE UPDATE ON pnq_jobs
  FOR EACH ROW EXECUTE FUNCTION pnq_touch_updated_at();

CREATE OR REPLACE FUNCTION pnq_register_node(
  p_node_id UUID,
  p_node_key TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS pnq_nodes AS $$
DECLARE
  v_node pnq_nodes;
BEGIN
  INSERT INTO pnq_nodes (id, node_key, metadata)
  VALUES (p_node_id, p_node_key, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (id) DO UPDATE
    SET node_key = EXCLUDED.node_key,
        metadata = pnq_nodes.metadata || EXCLUDED.metadata
  RETURNING * INTO v_node;
  RETURN v_node;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pnq_bump_connection_epoch(
  p_node_id UUID,
  p_expected_epoch BIGINT
) RETURNS pnq_nodes AS $$
DECLARE
  v_node pnq_nodes;
BEGIN
  UPDATE pnq_nodes
  SET connection_epoch = connection_epoch + 1
  WHERE id = p_node_id
    AND connection_epoch = p_expected_epoch
  RETURNING * INTO v_node;

  IF NOT FOUND THEN
    INSERT INTO pnq_resolution_audit (
      node_id, event_type, decision, expected_epoch, evidence
    ) VALUES (
      p_node_id, 'epoch_rejected', 'rejected', p_expected_epoch,
      jsonb_build_object('operation', 'bump_connection_epoch')
    );
    SELECT * INTO v_node FROM pnq_nodes WHERE id = p_node_id;
    RETURN v_node;
  END IF;

  RETURN v_node;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pnq_enqueue_job(
  p_node_id UUID,
  p_request_key TEXT,
  p_request_payload JSONB,
  p_queue_deadline_at TIMESTAMPTZ,
  p_dispatch_deadline_at TIMESTAMPTZ,
  p_execution_deadline_at TIMESTAMPTZ,
  p_result_deadline_at TIMESTAMPTZ,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS pnq_jobs AS $$
DECLARE
  v_node pnq_nodes;
  v_existing pnq_jobs;
  v_job pnq_jobs;
  v_node_seq BIGINT;
BEGIN
  IF p_request_key IS NULL OR length(p_request_key) = 0 THEN
    RAISE EXCEPTION 'request_key is required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_node
  FROM pnq_nodes
  WHERE id = p_node_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pnq node % does not exist', p_node_id USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_existing
  FROM pnq_jobs
  WHERE node_id = p_node_id
    AND request_key = p_request_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.request_payload <> p_request_payload THEN
      INSERT INTO pnq_resolution_audit (
        job_id, node_id, event_type, decision, evidence
      ) VALUES (
        v_existing.id, p_node_id, 'payload_conflict', 'rejected',
        jsonb_build_object('request_key', p_request_key)
      );
      RETURN v_existing;
    END IF;

    INSERT INTO pnq_resolution_audit (
      job_id, node_id, event_type, decision, evidence
    ) VALUES (
      v_existing.id, p_node_id, 'enqueue_idempotent_replay', 'ignored',
      jsonb_build_object('request_key', p_request_key)
    );
    RETURN v_existing;
  END IF;

  v_node_seq := v_node.next_node_seq;

  UPDATE pnq_nodes
  SET next_node_seq = next_node_seq + 1
  WHERE id = p_node_id;

  INSERT INTO pnq_jobs (
    node_id, node_seq, request_key, request_payload,
    queue_deadline_at, dispatch_deadline_at, execution_deadline_at, result_deadline_at,
    metadata
  ) VALUES (
    p_node_id, v_node_seq, p_request_key, p_request_payload,
    p_queue_deadline_at, p_dispatch_deadline_at, p_execution_deadline_at, p_result_deadline_at,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pnq_start_execution(
  p_job_id UUID,
  p_connection_epoch BIGINT,
  p_expected_job_version BIGINT,
  p_expected_dispatch_generation BIGINT,
  p_execution_id UUID,
  p_actor TEXT DEFAULT 'pnq-v2-dispatcher'
) RETURNS pnq_jobs AS $$
DECLARE
  v_job pnq_jobs;
  v_epoch BIGINT;
  v_target_status TEXT;
BEGIN
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'execution_id is required when entering execution' USING ERRCODE = '23514';
  END IF;

  SELECT n.connection_epoch INTO v_epoch
  FROM pnq_jobs j
  JOIN pnq_nodes n ON n.id = j.node_id
  WHERE j.id = p_job_id
  FOR UPDATE OF n;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pnq job % does not exist', p_job_id USING ERRCODE = '23503';
  END IF;

  IF v_epoch <> p_connection_epoch THEN
    INSERT INTO pnq_resolution_audit (
      job_id, event_type, decision, observed_epoch, expected_epoch, execution_id, actor
    ) VALUES (
      p_job_id, 'epoch_rejected', 'rejected', p_connection_epoch, v_epoch, p_execution_id, p_actor
    );
    SELECT * INTO v_job FROM pnq_jobs WHERE id = p_job_id;
    RETURN v_job;
  END IF;

  SELECT lifecycle_transition_target(
    'pnq_jobs'::regclass,
    current_job.status,
    jsonb_build_object('targetTerminal', FALSE, 'markStarted', TRUE)
  )
  INTO v_target_status
  FROM pnq_jobs current_job
  WHERE current_job.id = p_job_id;

  IF v_target_status IS NULL THEN
    SELECT * INTO v_job FROM pnq_jobs WHERE id = p_job_id;
    IF v_job.execution_started_at IS NOT NULL THEN
      INSERT INTO pnq_resolution_audit (
        job_id, event_type, decision, expected_job_version, expected_generation, execution_id, actor
      ) VALUES (
        p_job_id, 'cas_lost', 'ignored', p_expected_job_version, p_expected_dispatch_generation,
        p_execution_id, p_actor
      );
      RETURN v_job;
    END IF;
    RAISE EXCEPTION 'no configured execution-start transition for pnq job %', p_job_id
      USING ERRCODE = '55000';
  END IF;

  UPDATE pnq_jobs AS j
  SET status = v_target_status,
      execution_started_at = NOW(),
      job_version = j.job_version + 1
  WHERE j.id = p_job_id
    AND j.terminal_at IS NULL
    AND j.dispatch_started_at IS NOT NULL
    AND j.execution_started_at IS NULL
    AND j.execution_id = p_execution_id
    AND j.claimed_connection_epoch = p_connection_epoch
    AND j.job_version = p_expected_job_version
    AND j.dispatch_generation = p_expected_dispatch_generation
    AND EXISTS (
      SELECT 1
      FROM pnq_nodes n
      WHERE n.id = j.node_id
        AND n.connection_epoch = p_connection_epoch
    )
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    INSERT INTO pnq_resolution_audit (
      job_id, event_type, decision, expected_job_version, expected_generation, execution_id, actor
    ) VALUES (
      p_job_id, 'cas_lost', 'ignored', p_expected_job_version, p_expected_dispatch_generation,
      p_execution_id, p_actor
    );
    SELECT * INTO v_job FROM pnq_jobs WHERE id = p_job_id;
    RETURN v_job;
  END IF;

  RETURN v_job;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pnq_claim_next_job(
  p_node_id UUID,
  p_connection_epoch BIGINT,
  p_execution_id UUID,
  p_actor TEXT DEFAULT 'pnq-v2-dispatcher'
) RETURNS pnq_jobs AS $$
DECLARE
  v_job pnq_jobs;
  v_epoch BIGINT;
  v_target_status TEXT;
BEGIN
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'execution_id is required when claiming execution' USING ERRCODE = '23514';
  END IF;

  SELECT connection_epoch INTO v_epoch
  FROM pnq_nodes
  WHERE id = p_node_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pnq node % does not exist', p_node_id USING ERRCODE = '23503';
  END IF;

  IF v_epoch <> p_connection_epoch THEN
    INSERT INTO pnq_resolution_audit (
      node_id, event_type, decision, observed_epoch, expected_epoch, execution_id, actor
    ) VALUES (
      p_node_id, 'epoch_rejected', 'rejected', p_connection_epoch, v_epoch, p_execution_id, p_actor
    );
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pnq_jobs
    WHERE node_id = p_node_id
      AND execution_id IS NOT NULL
      AND terminal_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_job
  FROM pnq_jobs
  WHERE node_id = p_node_id
    AND execution_id IS NULL
    AND terminal_at IS NULL
    AND lifecycle_state_matches(
      'pnq_jobs'::regclass,
      status,
      jsonb_build_object('initial', TRUE)
    )
  ORDER BY node_seq ASC
  FOR UPDATE
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_target_status := lifecycle_transition_target(
    'pnq_jobs'::regclass,
    v_job.status,
    jsonb_build_object('targetTerminal', FALSE, 'automatic', TRUE)
  );
  IF v_target_status IS NULL THEN
    RAISE EXCEPTION 'no configured automatic claim transition for pnq job %', v_job.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE pnq_jobs job
  SET status = v_target_status,
      execution_id = p_execution_id,
      claimed_connection_epoch = p_connection_epoch,
      dispatch_started_at = COALESCE(dispatch_started_at, NOW()),
      job_version = job.job_version + 1,
      dispatch_generation = job.dispatch_generation + 1
  WHERE job.id = v_job.id
    AND job.job_version = v_job.job_version
    AND job.dispatch_generation = v_job.dispatch_generation
  RETURNING job.* INTO v_job;

  IF FOUND THEN
    RETURN v_job;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pnq_record_result(
  p_job_id UUID,
  p_execution_id UUID,
  p_connection_epoch BIGINT,
  p_dispatch_generation BIGINT,
  p_success BOOLEAN,
  p_result_payload JSONB DEFAULT '{}'::jsonb,
  p_actor TEXT DEFAULT 'pnq-v2-result'
) RETURNS pnq_jobs AS $$
DECLARE
  v_current pnq_jobs;
  v_job pnq_jobs;
  v_epoch BIGINT;
  v_event_type TEXT;
  v_target_status TEXT;
BEGIN
  SELECT n.connection_epoch INTO v_epoch
  FROM pnq_jobs j
  JOIN pnq_nodes n ON n.id = j.node_id
  WHERE j.id = p_job_id
  FOR UPDATE OF n;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pnq job % does not exist', p_job_id USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_current
  FROM pnq_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pnq job % does not exist', p_job_id USING ERRCODE = '23503';
  END IF;

  IF v_current.claimed_connection_epoch IS DISTINCT FROM p_connection_epoch
    OR v_epoch <> p_connection_epoch THEN
    INSERT INTO pnq_resolution_audit (
      job_id, node_id, event_type, decision,
      observed_epoch, expected_epoch,
      observed_generation, expected_generation,
      execution_id, evidence, actor
    ) VALUES (
      v_current.id, v_current.node_id, 'stale_result', 'rejected',
      p_connection_epoch, v_epoch,
      p_dispatch_generation, v_current.dispatch_generation,
      p_execution_id,
      jsonb_build_object(
        'claimed_connection_epoch', v_current.claimed_connection_epoch,
        'current_status', v_current.status,
        'reason', 'connection_epoch_mismatch'
      ),
      p_actor
    );
    RETURN v_current;
  END IF;

  IF v_current.terminal_at IS NOT NULL
    OR v_current.execution_started_at IS NULL
    OR v_current.execution_id IS DISTINCT FROM p_execution_id
    OR v_current.dispatch_generation <> p_dispatch_generation THEN
    v_event_type := CASE
      WHEN v_current.terminal_at IS NOT NULL THEN 'late_result'
      ELSE 'stale_result'
    END;

    INSERT INTO pnq_resolution_audit (
      job_id, node_id, event_type, decision,
      observed_generation, expected_generation,
      execution_id, evidence, actor
    ) VALUES (
      v_current.id, v_current.node_id, v_event_type, 'ignored',
      p_dispatch_generation, v_current.dispatch_generation,
      p_execution_id,
      jsonb_build_object(
        'current_status', v_current.status,
        'current_execution_id', v_current.execution_id,
        'incoming_success', p_success
      ),
      p_actor
    );

    RETURN v_current;
  END IF;

  v_target_status := lifecycle_transition_target(
    'pnq_jobs'::regclass,
    v_current.status,
    jsonb_build_object(
      'targetTerminal', TRUE,
      'targetRetryable', NOT p_success,
      'targetAdministrative', FALSE,
      'markCompleted', TRUE
    )
  );
  IF v_target_status IS NULL THEN
    RAISE EXCEPTION 'no configured result transition for pnq job %', p_job_id
      USING ERRCODE = '55000';
  END IF;

  UPDATE pnq_jobs AS j
  SET status = v_target_status,
      result_payload = COALESCE(p_result_payload, '{}'::jsonb),
      terminal_at = NOW(),
      terminal_reason = CASE WHEN p_success THEN 'result_succeeded' ELSE 'result_failed' END,
      job_version = j.job_version + 1
  WHERE j.id = p_job_id
    AND j.job_version = v_current.job_version
    AND j.dispatch_generation = v_current.dispatch_generation
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    INSERT INTO pnq_resolution_audit (
      job_id, node_id, event_type, decision,
      expected_job_version, expected_generation, execution_id, actor
    ) VALUES (
      v_current.id, v_current.node_id, 'cas_lost', 'ignored',
      v_current.job_version, v_current.dispatch_generation, p_execution_id, p_actor
    );
    RAISE EXCEPTION 'CAS lost while recording result for pnq job %', p_job_id USING ERRCODE = '40001';
  END IF;

  RETURN v_job;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pnq_mark_stuck(
  p_job_id UUID,
  p_reason TEXT,
  p_evidence JSONB DEFAULT '{}'::jsonb,
  p_actor TEXT DEFAULT 'pnq-v2-recovery'
) RETURNS pnq_jobs AS $$
DECLARE
  v_current pnq_jobs;
  v_job pnq_jobs;
  v_target_status TEXT;
BEGIN
  SELECT * INTO v_current
  FROM pnq_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pnq job % does not exist', p_job_id USING ERRCODE = '23503';
  END IF;

  IF v_current.terminal_at IS NOT NULL THEN
    RETURN v_current;
  END IF;

  v_target_status := lifecycle_transition_target(
    'pnq_jobs'::regclass,
    v_current.status,
    jsonb_build_object('targetTerminal', TRUE, 'targetAdministrative', TRUE)
  );
  IF v_target_status IS NULL THEN
    RAISE EXCEPTION 'no configured administrative terminal transition for pnq job %', p_job_id
      USING ERRCODE = '55000';
  END IF;

  UPDATE pnq_jobs
  SET status = v_target_status,
      terminal_at = NOW(),
      terminal_reason = p_reason,
      last_error = p_reason,
      job_version = job_version + 1
  WHERE id = p_job_id
    AND terminal_at IS NULL
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    RETURN v_current;
  END IF;

  INSERT INTO pnq_resolution_audit (
    job_id, node_id, event_type, decision,
    observed_job_version, observed_generation, execution_id, evidence, actor
  ) VALUES (
    v_job.id, v_job.node_id, 'marked_stuck', 'stuck',
    v_current.job_version, v_current.dispatch_generation, v_job.execution_id,
    COALESCE(p_evidence, '{}'::jsonb) || jsonb_build_object('reason', p_reason),
    p_actor
  );

  RETURN v_job;
END;
$$ LANGUAGE plpgsql;
