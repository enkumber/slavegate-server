-- Generic table-to-lifecycle binding and fail-closed initial-state assignment.
-- No lifecycle key, status, action, transition, or policy is seeded here.

CREATE TABLE IF NOT EXISTS lifecycle_resource_bindings (
  resource_table REGCLASS PRIMARY KEY,
  lifecycle_key TEXT NOT NULL,
  state_column NAME NOT NULL DEFAULT 'status',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upgrade bindings created by the earlier two-column contract. Existing
-- bindings used the generic status-column convention, while callers may
-- override it explicitly after this structural upgrade.
ALTER TABLE lifecycle_resource_bindings
  ADD COLUMN IF NOT EXISTS state_column NAME NOT NULL DEFAULT 'status';

ALTER TABLE lifecycle_resource_bindings
  DROP CONSTRAINT IF EXISTS lifecycle_resource_bindings_lifecycle_key_key;

-- Recover bindings already present in upgraded databases by inspecting every
-- ordinary table that has both lifecycle_key and status columns. A table is
-- bound only when its persisted rows agree on exactly one non-empty key.
DO $$
DECLARE
  resource RECORD;
  discovered_key TEXT;
  discovered_count BIGINT;
BEGIN
  FOR resource IN
    SELECT table_class.oid AS table_oid
      FROM pg_class table_class
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE table_class.relkind = 'r'
       AND namespace.nspname = ANY(current_schemas(FALSE))
       AND table_class.oid <> to_regclass('lifecycle_state_definitions')
       AND table_class.oid <> to_regclass('lifecycle_transitions')
       AND EXISTS (
         SELECT 1 FROM pg_attribute attribute
          WHERE attribute.attrelid = table_class.oid
            AND attribute.attname = 'lifecycle_key'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       )
       AND EXISTS (
         SELECT 1 FROM pg_attribute attribute
          WHERE attribute.attrelid = table_class.oid
            AND attribute.attname = 'status'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       )
  LOOP
    EXECUTE format(
      'SELECT MIN(lifecycle_key), COUNT(DISTINCT lifecycle_key) ' ||
      'FROM %s WHERE NULLIF(BTRIM(lifecycle_key), '''') IS NOT NULL',
      resource.table_oid::regclass
    ) INTO discovered_key, discovered_count;

    IF discovered_count = 1 THEN
      UPDATE lifecycle_resource_bindings
         SET lifecycle_key = discovered_key,
             updated_at = NOW()
       WHERE resource_table = resource.table_oid
         AND state_column = 'status';

      IF NOT FOUND THEN
        INSERT INTO lifecycle_resource_bindings(
          resource_table,
          lifecycle_key,
          state_column
        )
        VALUES (resource.table_oid, discovered_key, 'status');
      END IF;
    END IF;
  END LOOP;
END;
$$;

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
  target_has_lifecycle_key BOOLEAN;
BEGIN
  IF NULLIF(BTRIM(target_lifecycle_key), '') IS NULL THEN
    RAISE EXCEPTION 'lifecycle key is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM lifecycle_state_definitions
     WHERE lifecycle_key = target_lifecycle_key
  ) THEN
    RAISE EXCEPTION 'lifecycle configuration does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
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

  SELECT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = target_table
       AND attname = 'lifecycle_key'
       AND attnum > 0
       AND NOT attisdropped
  ) INTO target_has_lifecycle_key;

  constraint_name := format('lifecycle_status_fkey_%s', target_table::oid);
  IF target_has_lifecycle_key AND NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = target_table
       AND conname = constraint_name
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

-- Install the generic trigger for every binding recovered above.
DO $$
DECLARE
  binding RECORD;
BEGIN
  FOR binding IN
    SELECT resource_table, lifecycle_key, state_column
      FROM lifecycle_resource_bindings
  LOOP
    PERFORM configure_lifecycle_resource_binding(
      binding.resource_table,
      binding.lifecycle_key,
      binding.state_column
    );
  END LOOP;
END;
$$;
