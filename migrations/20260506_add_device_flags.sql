-- Add flags column to devices table
ALTER TABLE devices ADD COLUMN IF NOT EXISTS flags TEXT[] DEFAULT '{}';
