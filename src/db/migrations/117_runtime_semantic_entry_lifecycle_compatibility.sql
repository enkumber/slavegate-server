-- Remove packaged status policy left by the legacy runtime semantic catalog.
-- The migration changes schema mechanics only: operators choose lifecycle
-- identity, state, payload, priority and activation entirely in PostgreSQL.

ALTER TABLE runtime_semantic_entries
  ALTER COLUMN status DROP DEFAULT;

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT constraint_definition.conname
      FROM pg_constraint constraint_definition
      JOIN pg_attribute state_attribute
        ON state_attribute.attrelid = constraint_definition.conrelid
       AND state_attribute.attname = 'status'
     WHERE constraint_definition.conrelid = 'runtime_semantic_entries'::regclass
       AND constraint_definition.contype = 'c'
       AND state_attribute.attnum = ANY(constraint_definition.conkey)
  LOOP
    EXECUTE format(
      'ALTER TABLE runtime_semantic_entries DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END;
$$;
