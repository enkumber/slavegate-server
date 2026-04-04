-- Expand job_type constraint to include all supported job types
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (
  job_type = ANY (ARRAY[
    'tap','long_press','swipe','scroll','type_text','press_key',
    'open_app','open_app_fresh','close_app','pm_uninstall',
    'screenshot','screenshot_for_vlm','screen_record','ui_tree_dump',
    'screen_wake','screen_off','get_screen_state','unlock',
    'get_clipboard','set_clipboard',
    'file_push','file_delete',
    'wait_for_idle','reboot','ota_update',
    'rustdesk_enable',
    'a11y_find_tap','ocr_find_tap','ocr_full',
    'get_foreground_app','intent_send','skill_tap',
    'shell','install_apk','navigate','back','home'
  ])
);
