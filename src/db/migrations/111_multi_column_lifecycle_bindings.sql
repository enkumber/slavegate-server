-- Allow one resource table to expose multiple independently configured state
-- columns. This is generic mechanism only; no resource, lifecycle, state,
-- transition, action, or policy is named or seeded here.

ALTER TABLE lifecycle_resource_bindings
  DROP CONSTRAINT IF EXISTS lifecycle_resource_bindings_pkey;

ALTER TABLE lifecycle_resource_bindings
  ADD CONSTRAINT lifecycle_resource_bindings_pkey
  PRIMARY KEY (resource_table, state_column);

CREATE OR REPLACE FUNCTION set_initial_resource_lifecycle_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  configured RECORD;
  current_state TEXT;
  initial_state TEXT;
  binding_count INTEGER := 0;
  shared_lifecycle_key TEXT;
  lifecycle_key_count INTEGER;
  current_lifecycle_key TEXT;
  has_lifecycle_key_column BOOLEAN;
BEGIN
  SELECT MIN(binding.lifecycle_key), COUNT(DISTINCT binding.lifecycle_key)
    INTO shared_lifecycle_key, lifecycle_key_count
    FROM lifecycle_resource_bindings binding
   WHERE binding.resource_table = TG_RELID;

  SELECT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = TG_RELID
       AND attname = 'lifecycle_key'
       AND attnum > 0
       AND NOT attisdropped
  ) INTO has_lifecycle_key_column;

  IF has_lifecycle_key_column AND lifecycle_key_count = 1 THEN
    current_lifecycle_key := to_jsonb(NEW)->>'lifecycle_key';
    IF current_lifecycle_key IS NULL OR BTRIM(current_lifecycle_key) = '' THEN
      NEW := jsonb_populate_record(
        NEW,
        jsonb_build_object('lifecycle_key', shared_lifecycle_key)
      );
    ELSIF current_lifecycle_key <> shared_lifecycle_key THEN
      RAISE EXCEPTION 'resource lifecycle key disagrees with configured binding';
    END IF;
  END IF;

  FOR configured IN
    SELECT binding.lifecycle_key, binding.state_column
      FROM lifecycle_resource_bindings binding
     WHERE binding.resource_table = TG_RELID
     ORDER BY binding.state_column
  LOOP
    binding_count := binding_count + 1;
    current_state := to_jsonb(NEW)->>configured.state_column;
    IF current_state IS NULL OR BTRIM(current_state) = '' THEN
      SELECT definition.status
        INTO initial_state
        FROM lifecycle_state_definitions definition
       WHERE definition.lifecycle_key = configured.lifecycle_key
         AND definition.initial
       ORDER BY definition.sort_order, definition.status
       LIMIT 1;
      IF initial_state IS NULL THEN
        RAISE EXCEPTION 'bound lifecycle has no initial state configured';
      END IF;
      NEW := jsonb_populate_record(
        NEW,
        jsonb_build_object(configured.state_column, initial_state)
      );
    ELSIF NOT EXISTS (
      SELECT 1
        FROM lifecycle_state_definitions definition
       WHERE definition.lifecycle_key = configured.lifecycle_key
         AND definition.status = current_state
    ) THEN
      RAISE EXCEPTION 'resource state is absent from its configured lifecycle';
    END IF;
  END LOOP;

  IF binding_count = 0 THEN
    RAISE EXCEPTION 'resource table has no lifecycle binding configured';
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
