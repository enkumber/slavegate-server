-- Adopt lifecycle resources declared by PostgreSQL configuration.
--
-- This migration contains mechanism only. Resource tables, lifecycle keys,
-- states, transitions, actions, and policy are discovered from persisted
-- lifecycle_state_definitions metadata. Nothing operational is seeded here.

CREATE OR REPLACE FUNCTION adopt_configured_lifecycle_resources()
RETURNS TABLE(resource_table REGCLASS, lifecycle_key TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  configured RECORD;
  target_table REGCLASS;
  target_state_column NAME;
  target_identity_column NAME;
  constraint_row RECORD;
  invalid_state_exists BOOLEAN;
BEGIN
  FOR configured IN
    SELECT definition.lifecycle_key,
           MIN(definition.metadata->>'resourceTable') AS resource_table_name,
           MIN(COALESCE(NULLIF(definition.metadata->>'stateColumn', ''), 'status')) AS state_column_name,
           MIN(COALESCE(NULLIF(definition.metadata->>'identityColumn', ''), 'id')) AS identity_column_name,
           COUNT(DISTINCT definition.metadata->>'resourceTable') AS resource_table_count,
           COUNT(DISTINCT COALESCE(NULLIF(definition.metadata->>'stateColumn', ''), 'status')) AS state_column_count,
           COUNT(DISTINCT COALESCE(NULLIF(definition.metadata->>'identityColumn', ''), 'id')) AS identity_column_count
      FROM lifecycle_state_definitions definition
     WHERE NULLIF(BTRIM(definition.metadata->>'resourceTable'), '') IS NOT NULL
     GROUP BY definition.lifecycle_key
  LOOP
    IF configured.resource_table_count <> 1
       OR configured.state_column_count <> 1
       OR configured.identity_column_count <> 1 THEN
      RAISE EXCEPTION 'lifecycle resource metadata is inconsistent';
    END IF;

    target_table := to_regclass(configured.resource_table_name);
    target_state_column := configured.state_column_name::NAME;
    target_identity_column := configured.identity_column_name::NAME;

    IF target_table IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_attribute attribute
       WHERE attribute.attrelid = target_table
         AND attribute.attname = target_state_column
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    ) OR NOT EXISTS (
      SELECT 1
        FROM pg_attribute attribute
       WHERE attribute.attrelid = target_table
         AND attribute.attname = target_identity_column
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION 'configured lifecycle resource columns do not exist';
    END IF;

    EXECUTE format(
      'ALTER TABLE %s ADD COLUMN IF NOT EXISTS lifecycle_key TEXT',
      target_table
    );
    EXECUTE format(
      'UPDATE %s SET lifecycle_key = $1 WHERE lifecycle_key IS NULL',
      target_table
    ) USING configured.lifecycle_key;
    EXECUTE format(
      'ALTER TABLE %s ALTER COLUMN lifecycle_key SET NOT NULL',
      target_table
    );
    EXECUTE format(
      'ALTER TABLE %s ALTER COLUMN %I DROP DEFAULT',
      target_table,
      target_state_column
    );
    EXECUTE format(
      'UPDATE %s resource SET %I = initial.status ' ||
      'FROM (' ||
      '  SELECT status FROM lifecycle_state_definitions ' ||
      '  WHERE lifecycle_key = $1 AND initial ' ||
      '  ORDER BY sort_order, status LIMIT 1' ||
      ') initial WHERE resource.%I IS NULL OR BTRIM(resource.%I::text) = ''''',
      target_table,
      target_state_column,
      target_state_column,
      target_state_column
    ) USING configured.lifecycle_key;
    EXECUTE format(
      'ALTER TABLE %s ALTER COLUMN %I SET NOT NULL',
      target_table,
      target_state_column
    );

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

    EXECUTE format(
      'SELECT EXISTS (' ||
      'SELECT 1 FROM %s resource ' ||
      'LEFT JOIN lifecycle_state_definitions definition ' ||
      'ON definition.lifecycle_key = resource.lifecycle_key ' ||
      'AND definition.status = resource.%I ' ||
      'WHERE definition.status IS NULL' ||
      ')',
      target_table,
      target_state_column
    ) INTO invalid_state_exists;
    IF invalid_state_exists THEN
      RAISE EXCEPTION 'resource contains state values absent from its configured lifecycle';
    END IF;

    PERFORM configure_lifecycle_resource_binding(
      target_table,
      configured.lifecycle_key,
      target_state_column
    );

    resource_table := target_table;
    lifecycle_key := configured.lifecycle_key;
    RETURN NEXT;
  END LOOP;
END;
$$;

SELECT * FROM adopt_configured_lifecycle_resources();
