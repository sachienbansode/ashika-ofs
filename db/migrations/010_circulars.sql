-- 010 — NSE circular watch.
--
-- NSE publishes an RSS feed of every circular. A feed is published *to be polled* —
-- that is what RSS is for — so this is not the automated collection the exchanges'
-- website terms prohibit, and it needs no consent. It is also free.
--
-- Each OFS gets a circular titled "Proposed Offer for Sale by <Company>" under the
-- CMTR department, so polling the feed answers the question that actually costs
-- money: "is there an OFS today that we have not set up?"
--
-- This stores the ANNOUNCEMENT, not the issue. The circular is a PDF; a human still
-- reads it and fills in floor price and windows. What the desk gains is that nothing
-- is missed and nobody has to watch a website.
CREATE TABLE IF NOT EXISTS ofs.ofs_circular (
  id           bigserial   PRIMARY KEY,
  source       text        NOT NULL DEFAULT 'NSE',
  guid         text        NOT NULL,               -- the item link; the feed has no <guid>
  title        text        NOT NULL,
  link         text,
  department   text,                               -- CMTR, CMPT, SURV ... from the filename
  company      text,                               -- parsed out of the title, best effort
  published_at timestamptz,
  is_ofs       boolean     NOT NULL DEFAULT false, -- matched the OFS title pattern
  status       text        NOT NULL DEFAULT 'new', -- new | reviewed | imported | ignored
  issue_id     bigint      REFERENCES ofs.ofs_issue(id) ON DELETE SET NULL,
  note         text,
  handled_by   text,
  handled_at   timestamptz,
  alerted_at   timestamptz,                        -- when the email went out
  seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ofs_circular_status_ck CHECK (status IN ('new','reviewed','imported','ignored')),
  CONSTRAINT ofs_circular_uq UNIQUE (source, guid)
);

CREATE INDEX IF NOT EXISTS ofs_circular_new_ix ON ofs.ofs_circular (published_at DESC)
  WHERE is_ofs AND status = 'new';
CREATE INDEX IF NOT EXISTS ofs_circular_pub_ix ON ofs.ofs_circular (published_at DESC);

-- Conditional-GET state, so a poll every few minutes costs one 304 rather than a
-- full download. Being a good citizen on someone else's feed is not optional.
CREATE TABLE IF NOT EXISTS ofs.ofs_feed_state (
  source        text PRIMARY KEY,
  etag          text,
  last_modified text,
  last_poll_at  timestamptz,
  last_ok_at    timestamptz,
  last_status   int,
  items_seen    int NOT NULL DEFAULT 0,
  last_error    text
);

INSERT INTO ofs.ofs_setting (key, value, description) VALUES
  ('circulars_enabled',      '1',  'Poll the NSE circulars RSS feed for OFS announcements'),
  ('circulars_poll_minutes', '15', 'Minutes between circular polls'),
  ('circulars_alert_email',  '',   'Email address alerted when a new OFS circular appears (blank = no email)')
ON CONFLICT (key) DO NOTHING;
