-- 007 — exchange pull: run history, live progress, and the schedule.
--
-- A pull is not a request/response: it walks several endpoints per exchange and can
-- take a minute. So it is recorded as a ROW that the desk polls, rather than a
-- response the browser has to wait for. `steps` is the running log the progress bar
-- is drawn from; `summary` is what landed.
CREATE TABLE IF NOT EXISTS ofs.ofs_sync_run (
  id           bigserial   PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  trigger      text        NOT NULL DEFAULT 'manual',   -- manual | schedule | startup
  actor        text,
  exchanges    text[]      NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'running',  -- running | ok | partial | failed
  progress     int         NOT NULL DEFAULT 0,          -- 0..100, for the bar
  found        int         NOT NULL DEFAULT 0,
  inserted     int         NOT NULL DEFAULT 0,
  updated      int         NOT NULL DEFAULT 0,
  unchanged    int         NOT NULL DEFAULT 0,
  rejected     int         NOT NULL DEFAULT 0,
  steps        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  summary      jsonb,
  error        text,
  CONSTRAINT ofs_sync_run_status_ck  CHECK (status  IN ('running','ok','partial','failed')),
  CONSTRAINT ofs_sync_run_trigger_ck CHECK (trigger IN ('manual','schedule','startup'))
);

CREATE INDEX IF NOT EXISTS ofs_sync_run_started_ix ON ofs.ofs_sync_run (started_at DESC);
-- At most one pull in flight: a second one would race the first into ofs_issue.
CREATE UNIQUE INDEX IF NOT EXISTS ofs_sync_run_one_live_ix ON ofs.ofs_sync_run ((status))
  WHERE status = 'running';

INSERT INTO ofs.ofs_setting (key, value, description) VALUES
  ('sync_enabled',      '0',       'Pull the issue master from the exchanges on a schedule'),
  ('sync_every_minutes','60',      'Minutes between scheduled pulls'),
  ('sync_exchanges',    'NSE,BSE', 'Which exchanges a scheduled pull covers'),
  ('sync_market_only',  '1',       'Only run the schedule while the market is open'),
  ('market_open',       '09:15',   'Session start (IST). No bid is accepted before it'),
  ('market_close',      '15:30',   'Session end (IST). The desk cut-off overrides this'),
  ('market_days',       '1-5',     'Trading days, 0=Sunday. Default Monday to Friday'),
  ('trading_holidays',  '',        'Comma-separated YYYY-MM-DD dates the market is shut')
ON CONFLICT (key) DO NOTHING;
