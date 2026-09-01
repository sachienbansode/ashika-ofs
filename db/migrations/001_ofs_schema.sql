-- Ashika OFS - schema bootstrap
-- Runs on the shared Ananta instance (uat_ananta_staging), alongside stg / dwh.
-- Apply:  psql -h 13.233.106.37 -U <user> -d uat_ananta_staging -f db/migrations/001_ofs_schema.sql
-- (password via PGPASSWORD env var only)

CREATE SCHEMA IF NOT EXISTS ofs;
SET search_path = ofs, public;

-- ---------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS ofs.ofs_setting (
  key           text PRIMARY KEY,
  value         text NOT NULL,
  description   text,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ofs.ofs_setting (key, value, description) VALUES
  ('retail_cap',        '200000', 'Max application value for a Retail bid (SEBI Rs 2 lakh)'),
  ('hni_min',           '200000', 'Minimum application value for an HNI / Non-Institutional bid'),
  ('daily_cutoff',      '15:15',  'Desk cut-off time (IST) after which no bid is accepted'),
  ('enforce_margin',    '1',      'Block bids exceeding free margin (1) or warn only (0)'),
  ('margin_type',       '2',      'Margin type code written to the exchange bid file'),
  ('cat_retail',        'RI',     'Exchange category code - Retail price bid'),
  ('cat_retail_cutoff', 'RIC',    'Exchange category code - Retail cut-off bid'),
  ('cat_hni',           'NII',    'Exchange category code - Non-Institutional / HNI'),
  ('cutoff_price_mode', 'zero',   'Price written for a cut-off bid: zero | floor')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- issues
CREATE TABLE IF NOT EXISTS ofs.ofs_issue (
  id            bigserial PRIMARY KEY,
  symbol        text        NOT NULL,
  company       text        NOT NULL,
  isin          text        NOT NULL,
  series        text        NOT NULL DEFAULT 'EQ',
  exchange      text        NOT NULL DEFAULT 'NSE',   -- NSE | BSE | BOTH
  bse_scrip_code text,                                 -- BSE scrip code for the iBBS file
  floor_price   numeric(18,4) NOT NULL,
  cut_price_min numeric(18,4),                        -- Retail cut-off floor; defaults to floor_price
  tick          numeric(10,4) NOT NULL DEFAULT 0.05,
  lot           integer       NOT NULL DEFAULT 1,
  issue_qty     bigint,                               -- total shares on offer (for subscription x)
  retail_qty    bigint,                               -- reserved retail portion (>= 10%)
  discount_pct  numeric(6,3)  NOT NULL DEFAULT 0,
  cutoff_flag   boolean       NOT NULL DEFAULT true,  -- cut-off bidding allowed for Retail
  hni_open      timestamptz NOT NULL,
  hni_close     timestamptz NOT NULL,
  ret_open      timestamptz NOT NULL,
  ret_close     timestamptz NOT NULL,
  -- The T-day (Non-Retail day) as a plain date. Held explicitly because
  -- hni_open::date is STABLE, not IMMUTABLE (the cast depends on the session
  -- TimeZone), so it cannot appear in an index expression. Filled by the
  -- ofs_issue_fill_date trigger below when the caller omits it.
  issue_date    date        NOT NULL,
  indicative_ri numeric(18,4),                        -- from terminal; manual in Phase 1
  indicative_ni numeric(18,4),
  status        text        NOT NULL DEFAULT 'Auto',  -- Auto | Suspended | Closed
  source        text        NOT NULL DEFAULT 'manual',-- manual | csv | circular
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ofs_issue_exchange_ck CHECK (exchange IN ('NSE','BSE','BOTH')),
  CONSTRAINT ofs_issue_status_ck   CHECK (status IN ('Auto','Suspended','Closed')),
  CONSTRAINT ofs_issue_win_ck      CHECK (hni_close > hni_open AND ret_close > ret_open),
  CONSTRAINT ofs_issue_price_ck    CHECK (floor_price > 0 AND tick > 0 AND lot >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS ofs_issue_uq ON ofs.ofs_issue (upper(btrim(symbol)), upper(btrim(isin)), issue_date);
CREATE INDEX IF NOT EXISTS ofs_issue_open_ix ON ofs.ofs_issue (ret_close DESC);

-- ---------------------------------------------------------------- bids
CREATE TABLE IF NOT EXISTS ofs.ofs_bid (
  id            bigserial PRIMARY KEY,
  ref           text        NOT NULL UNIQUE,          -- human ref shown to desk/client
  issue_id      bigint      NOT NULL REFERENCES ofs.ofs_issue(id) ON DELETE RESTRICT,
  client_ucc    text        NOT NULL,                 -- upper(btrim()) of dwh.tbl_user_info.ucc
  cp_code       text,                                 -- Client/CP code for the exchange file
  custody_code  text,
  category      text        NOT NULL,                 -- Retail | HNI
  placed_by     text        NOT NULL DEFAULT 'desk',  -- desk | client | ap
  placed_by_id  text,                                 -- staff user id / AP id
  qty           bigint      NOT NULL,
  price         numeric(18,4),                        -- NULL when is_cutoff
  is_cutoff     boolean     NOT NULL DEFAULT false,
  value         numeric(20,4) NOT NULL,
  status        text        NOT NULL DEFAULT 'Live',  -- Live | Modified | Cancelled | Rejected
  reject_reason text,
  exch_order_no text,                                 -- NOW/e-OFS order no. for modify/cancel rows
  otp_verified  boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ofs_bid_cat_ck    CHECK (category IN ('Retail','HNI')),
  CONSTRAINT ofs_bid_status_ck CHECK (status IN ('Live','Modified','Cancelled','Rejected')),
  CONSTRAINT ofs_bid_by_ck     CHECK (placed_by IN ('desk','client','ap')),
  CONSTRAINT ofs_bid_qty_ck    CHECK (qty > 0),
  CONSTRAINT ofs_bid_price_ck  CHECK (is_cutoff OR price IS NOT NULL)
);
-- one LIVE bid per client per issue (spec: one bid per scrip per client)
CREATE UNIQUE INDEX IF NOT EXISTS ofs_bid_one_live_uq
  ON ofs.ofs_bid (issue_id, client_ucc) WHERE status = 'Live';
CREATE INDEX IF NOT EXISTS ofs_bid_issue_ix  ON ofs.ofs_bid (issue_id, status);
CREATE INDEX IF NOT EXISTS ofs_bid_client_ix ON ofs.ofs_bid (client_ucc);

-- ---------------------------------------------------------------- margin
CREATE TABLE IF NOT EXISTS ofs.ofs_margin (
  client_ucc    text PRIMARY KEY,
  available     numeric(20,4) NOT NULL DEFAULT 0,
  source        text          NOT NULL DEFAULT 'manual',  -- manual | csv | rms
  note          text,
  updated_by    text,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ofs_margin_src_ck CHECK (source IN ('manual','csv','rms'))
);
CREATE TABLE IF NOT EXISTS ofs.ofs_margin_log (
  id          bigserial PRIMARY KEY,
  client_ucc  text NOT NULL,
  old_value   numeric(20,4),
  new_value   numeric(20,4) NOT NULL,
  source      text,
  note        text,
  actor       text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ofs_margin_log_ix ON ofs.ofs_margin_log (client_ucc, at DESC);

-- ---------------------------------------------------------------- allotment
CREATE TABLE IF NOT EXISTS ofs.ofs_allotment (
  id           bigserial PRIMARY KEY,
  issue_id     bigint NOT NULL REFERENCES ofs.ofs_issue(id) ON DELETE CASCADE,
  bid_id       bigint REFERENCES ofs.ofs_bid(id) ON DELETE SET NULL,
  client_ucc   text   NOT NULL,
  allot_qty    bigint NOT NULL DEFAULT 0,
  allot_price  numeric(18,4),
  allot_value  numeric(20,4) NOT NULL DEFAULT 0,
  mail_status  text   NOT NULL DEFAULT 'pending',   -- pending | sent | failed | skipped
  mail_at      timestamptz,
  imported_by  text,
  allotted_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ofs_allot_mail_ck CHECK (mail_status IN ('pending','sent','failed','skipped'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ofs_allot_uq ON ofs.ofs_allotment (issue_id, client_ucc);

-- ---------------------------------------------------------------- export audit
CREATE TABLE IF NOT EXISTS ofs.ofs_export_log (
  id           bigserial PRIMARY KEY,
  issue_id     bigint REFERENCES ofs.ofs_issue(id) ON DELETE SET NULL,
  exchange     text   NOT NULL,                     -- NSE | BSE
  format       text   NOT NULL,                     -- csv | txt | xlsx
  file_name    text   NOT NULL,
  row_count    integer NOT NULL,
  total_qty    bigint,
  total_value  numeric(20,4),
  checksum     text   NOT NULL,                     -- sha256 of the exact bytes served
  filters      jsonb,
  generated_by text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ofs_export_exch_ck CHECK (exchange IN ('NSE','BSE'))
);
CREATE INDEX IF NOT EXISTS ofs_export_ix ON ofs.ofs_export_log (issue_id, generated_at DESC);

-- ---------------------------------------------------------------- audit
CREATE TABLE IF NOT EXISTS ofs.ofs_audit (
  id      bigserial PRIMARY KEY,
  actor   text,
  action  text NOT NULL,
  entity  text NOT NULL,
  entity_id text,
  before  jsonb,
  after   jsonb,
  ip      inet,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ofs_audit_ix ON ofs.ofs_audit (entity, entity_id, at DESC);

-- ---------------------------------------------------------------- client data (NOT here)
-- There is deliberately no ofs_client table or view.
-- OFS state lives in the `ofs_bids` database; LD/DWH lives in `uat_ananta_staging`.
-- Postgres cannot join across databases, so client identity is read at request time
-- through db/ldAdapter.js and merged in the application. Client master is never
-- copied into this database - only the UCC is stored, as a reference.

-- ---------------------------------------------------------------- updated_at triggers
CREATE OR REPLACE FUNCTION ofs.touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- Derive the trading day from the Non-Retail window open, in IST, when the caller
-- did not supply it. A BEFORE trigger may use STABLE expressions; an index may not.
CREATE OR REPLACE FUNCTION ofs.fill_issue_date() RETURNS trigger AS $$
BEGIN
  IF NEW.issue_date IS NULL THEN
    NEW.issue_date := (NEW.hni_open AT TIME ZONE 'Asia/Kolkata')::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ofs_issue_fill_date ON ofs.ofs_issue;
CREATE TRIGGER ofs_issue_fill_date BEFORE INSERT OR UPDATE ON ofs.ofs_issue
  FOR EACH ROW EXECUTE FUNCTION ofs.fill_issue_date();

DROP TRIGGER IF EXISTS ofs_issue_touch ON ofs.ofs_issue;
CREATE TRIGGER ofs_issue_touch BEFORE UPDATE ON ofs.ofs_issue
  FOR EACH ROW EXECUTE FUNCTION ofs.touch_updated_at();
DROP TRIGGER IF EXISTS ofs_bid_touch ON ofs.ofs_bid;
CREATE TRIGGER ofs_bid_touch BEFORE UPDATE ON ofs.ofs_bid
  FOR EACH ROW EXECUTE FUNCTION ofs.touch_updated_at();
