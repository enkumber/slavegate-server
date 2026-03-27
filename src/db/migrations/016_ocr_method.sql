-- Migration 016: Add 'ocr' to navigation_logs.method_used CHECK constraint
-- Required for OCR cascade level (Level 3) to log successfully.
-- Without this, INSERT with method_used='ocr' causes constraint violation.

BEGIN;

ALTER TABLE navigation_logs
  DROP CONSTRAINT IF EXISTS navigation_logs_method_used_check;

ALTER TABLE navigation_logs
  ADD CONSTRAINT navigation_logs_method_used_check
  CHECK (method_used IN ('coords', 'ui_tree', 'ocr', 'vision', 'text_search'));

-- Note: 'text_search' included for consistency — Mode 2 cascade-tap uses text_search
-- but does not currently log to DB. Added here to future-proof the constraint.

COMMIT;
