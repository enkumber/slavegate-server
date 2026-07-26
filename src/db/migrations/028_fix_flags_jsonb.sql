-- Fix flags column: convert from text[] to jsonb
-- The ops-monitor code uses jsonb operators (||) on flags

-- First remove default
ALTER TABLE devices ALTER COLUMN flags DROP DEFAULT;

-- Current schema already creates JSONB. Only legacy installations with a
-- text[] column need conversion; dynamic SQL keeps the migration valid for
-- both shapes.
DO $$
DECLARE
  flags_udt TEXT;
BEGIN
  SELECT udt_name
  INTO flags_udt
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'devices'
    AND column_name = 'flags';

  IF flags_udt = '_text' THEN
    EXECUTE $convert$
      ALTER TABLE devices
      ALTER COLUMN flags TYPE jsonb
      USING CASE
        WHEN flags IS NULL OR cardinality(flags) = 0 THEN '{}'::jsonb
        ELSE jsonb_build_object('legacy', to_jsonb(flags))
      END
    $convert$;
  ELSIF flags_udt = 'jsonb' THEN
    UPDATE devices SET flags = '{}'::jsonb WHERE flags IS NULL;
  END IF;
END
$$;

-- Set default
ALTER TABLE devices ALTER COLUMN flags SET DEFAULT '{}'::jsonb;
