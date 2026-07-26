-- Extend generic lifecycle bindings to arbitrary state columns declared by
-- PostgreSQL configuration. This migration contains mechanism only.

ALTER TABLE lifecycle_resource_bindings
  ADD COLUMN IF NOT EXISTS state_column NAME NOT NULL DEFAULT 'status';

CREATE OR REPLACE FUNCTION set_initial_resource_lifecycle_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  configured_lifecycle_key TEXT;
  configured_state_column NAME;
  current_state TEXT;
  initial_state TEXT;
BEGIN
  SELECT binding.lifecycle_key, binding.state_column
    INTO configured_lifecycle_key, configured_state_column
    FROM lifecycle_resource_bindings binding
   WHERE binding.resource_table = TG_RELID;

  IF configured_lifecycle_key IS NULL THEN
    RAISE EXCEPTION 'resource table % has no lifecycle binding configured', TG_TABLE_NAME;
  END IF;

  IF NEW.lifecycle_key IS NULL OR BTRIM(NEW.lifecycle_key) = '' THEN
    NEW.lifecycle_key := configured_lifecycle_key;
  END IF;

  IF NEW.lifecycle_key <> configured_lifecycle_key THEN
    RAISE EXCEPTION 'invalid lifecycle binding for resource table %', TG_TABLE_NAME;
  END IF;

  current_state := to_jsonb(NEW)->>configured_state_column;
  IF current_state IS NULL OR BTRIM(current_state) = '' THEN
    SELECT definition.status
      INTO initial_state
      FROM lifecycle_state_definitions definition
     WHERE definition.lifecycle_key = NEW.lifecycle_key
       AND definition.initial
     ORDER BY definition.sort_order, definition.status
     LIMIT 1;

    IF initial_state IS NULL THEN
      RAISE EXCEPTION 'bound lifecycle has no initial state configured';
    END IF;
    NEW := jsonb_populate_record(NEW, jsonb_build_object(configured_state_column, initial_state));
  END IF;

  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS configure_lifecycle_resource_binding(REGCLASS, TEXT);

CREATE OR REPLACE FUNCTION configure_lifecycle_resource_binding(
  target_table REGCLASS,
  target_lifecycle_key TEXT,
  target_state_column NAME DEFAULT 'status'
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  trigger_name TEXT;
  constraint_name TEXT;
BEGIN
  IF NULLIF(BTRIM(target_lifecycle_key), '') IS NULL THEN
    RAISE EXCEPTION 'lifecycle key is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM lifecycle_state_definitions
     WHERE lifecycle_key = target_lifecycle_key
  ) THEN
    RAISE EXCEPTION 'lifecycle configuration does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = target_table
       AND attname = target_state_column
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'configured lifecycle state column does not exist';
  END IF;

  UPDATE lifecycle_resource_bindings
     SET lifecycle_key = target_lifecycle_key,
         updated_at = NOW()
   WHERE resource_table = target_table
     AND state_column = target_state_column;

  IF NOT FOUND THEN
    INSERT INTO lifecycle_resource_bindings(
      resource_table,
      lifecycle_key,
      state_column
    )
    VALUES (target_table, target_lifecycle_key, target_state_column);
  END IF;

  trigger_name := format('trg_lifecycle_initial_%s', target_table::oid);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trigger_name, target_table);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE INSERT ON %s FOR EACH ROW ' ||
    'EXECUTE FUNCTION set_initial_resource_lifecycle_status()',
    trigger_name,
    target_table
  );

  constraint_name := format('lifecycle_status_fkey_%s', target_table::oid);
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = target_table AND conname = constraint_name
  ) THEN
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I ' ||
      'FOREIGN KEY (lifecycle_key, %I) ' ||
      'REFERENCES lifecycle_state_definitions(lifecycle_key, status) ' ||
      'ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID',
      target_table,
      constraint_name,
      target_state_column
    );
    EXECUTE format(
      'ALTER TABLE %s VALIDATE CONSTRAINT %I',
      target_table,
      constraint_name
    );
  END IF;
END;
$$;

SELECT * FROM adopt_configured_lifecycle_resources();
