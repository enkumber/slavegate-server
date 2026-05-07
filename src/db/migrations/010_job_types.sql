-- Migration 010: Add all supported job types to constraint

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;

ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN (
  -- UI Automation
  'tap', 'long_press', 'swipe', 'scroll', 'type_text', 'press_key',
  -- App Control
  'open_app', 'open_app_fresh', 'close_app', 'pm_uninstall',
  -- Screen
  'screenshot', 'screenshot_for_vlm', 'screen_record', 'ui_tree_dump', 'screen_wake', 'screen_off', 'get_screen_state', 'unlock',
  -- Vision / OCR
  'ocr_find_tap',
  -- Clipboard
  'get_clipboard', 'set_clipboard',
  -- Files
  'file_push', 'file_delete',
  -- System
  'wait_for_idle', 'reboot', 'ota_update'
));
