-- Fix flags column: convert from text[] to jsonb
-- The ops-monitor code uses jsonb operators (||) on flags

-- First remove default
ALTER TABLE devices ALTER COLUMN flags DROP DEFAULT;

-- Convert text[] to jsonb (empty array → empty object)
UPDATE devices SET flags = '{}'::jsonb WHERE flags = '{}'::text[] OR flags IS NULL;

-- Change type
ALTER TABLE devices ALTER COLUMN flags TYPE jsonb USING (
  CASE
    WHEN flags = '{}'::text[] THEN '{}'::jsonb
    ELSE '{}'::jsonb
  END
);

-- Set default
ALTER TABLE devices ALTER COLUMN flags SET DEFAULT '{}'::jsonb;
