-- Migration 016: Add 'ocr' to navigation_logs.method_used CHECK constraint
-- Required for OCR cascade level (Level 3) to log successfully.
-- Without this, INSERT with method_used='ocr' causes constraint violation.

BEGIN;

ALTER TABLE navigation_logs
  DROP CONSTRAINT IF EXISTS navigation_logs_method_used_check;

-- Method availability is runtime data and must not be constrained by a release.

COMMIT;
