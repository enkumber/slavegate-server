-- Lifecycle-bound state columns are governed by lifecycle_state_definitions.
-- Remove legacy CHECK constraints that package a competing list of values.
-- The mechanism is generic: tables, columns, lifecycles, and states are read
-- exclusively from lifecycle_resource_bindings and PostgreSQL catalogs.

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
  constraint_row RECORD;
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

  FOR constraint_row IN
    SELECT constraint_definition.conname
      FROM pg_constraint constraint_definition
     WHERE constraint_definition.conrelid = target_table
       AND constraint_definition.contype = 'c'
       AND pg_get_constraintdef(constraint_definition.oid) ~
           ('(^|[^a-zA-Z0-9_])' || target_state_column || '([^a-zA-Z0-9_]|$)')
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      target_table,
      constraint_row.conname
    );
  END LOOP;

  INSERT INTO lifecycle_resource_bindings(resource_table, lifecycle_key, state_column)
  VALUES (target_table, target_lifecycle_key, target_state_column)
  ON CONFLICT (resource_table, state_column) DO UPDATE
    SET lifecycle_key = EXCLUDED.lifecycle_key,
        updated_at = NOW();

  trigger_name := format('trg_lifecycle_initial_%s', target_table::oid);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trigger_name, target_table);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %s FOR EACH ROW ' ||
    'EXECUTE FUNCTION set_initial_resource_lifecycle_status()',
    trigger_name,
    target_table
  );
END;
$$;

DO $$
DECLARE
  configured RECORD;
BEGIN
  FOR configured IN
    SELECT resource_table, lifecycle_key, state_column
      FROM lifecycle_resource_bindings
     ORDER BY resource_table::TEXT, state_column
  LOOP
    PERFORM configure_lifecycle_resource_binding(
      configured.resource_table,
      configured.lifecycle_key,
      configured.state_column
    );
  END LOOP;
END;
$$;
