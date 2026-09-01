-- 008 — the archive sweep runs on the scheduler, on its own switch.
-- archive_after_days already exists (005); this adds the on/off.
INSERT INTO ofs.ofs_setting (key, value, description) VALUES
  ('archive_auto', '1',
   'Archive an issue automatically once its last window closed more than archive_after_days ago')
ON CONFLICT (key) DO NOTHING;
