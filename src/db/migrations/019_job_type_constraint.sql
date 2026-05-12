-- Migration 019: Sync jobs_job_type_check constraint with dispatcher ALLOWED_JOB_TYPES
-- Adds: skill_tap, a11y_find_tap (used by cascade system, missing from original constraint)

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;

ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type = ANY (ARRAY[
  -- Touch / input
  'tap',
  'long_press',
  'swipe',
  'scroll',
  'type_text',
  'press_key',
  -- App management
  'open_app',
  'close_app',
  'pm_uninstall',
  -- Screen / capture
  'screenshot',
  'screenshot_for_vlm',
  'screen_record',
  'ui_tree_dump',
  -- Device state
  'screen_wake',
  'screen_off',
  'get_screen_state',
  'unlock',
  -- Clipboard
  'get_clipboard',
  'set_clipboard',
  -- File ops
  'file_push',
  'file_delete',
  -- Misc
  'wait_for_idle',
  'reboot',
  'ota_update',
  -- Skill / cascade system
  'skill_tap',
  'a11y_find_tap',
  'ocr_find_tap'
]::text[]));
