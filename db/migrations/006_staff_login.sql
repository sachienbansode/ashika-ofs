-- 006 — direct back-office sign-in.
--
-- OFS holds no staff password: routes/staffAuth.js verifies against
-- "admin-staging-api".users in the Ananta DB. What it DOES need locally is a place
-- to park the second factor between the two requests, and Postgres cannot write a
-- challenge row into a database it is not connected to — hence this table lives in
-- ofs_bids alongside the client challenges it mirrors.
--
-- The code itself is never stored; only sha256(code), as with ofs_client_otp.
CREATE TABLE IF NOT EXISTS ofs.ofs_staff_otp (
  ref          uuid        PRIMARY KEY,
  user_id      bigint      NOT NULL,          -- "admin-staging-api".users.id
  email        text        NOT NULL,
  otp_hash     text        NOT NULL,
  attempts     int         NOT NULL DEFAULT 0,
  max_attempts int         NOT NULL DEFAULT 5,
  delivered_to text,                          -- masked, for the UI
  channel      text        NOT NULL DEFAULT 'email',
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  ip           text,
  user_agent   text,
  CONSTRAINT ofs_staff_otp_channel_ck CHECK (channel IN ('email','test'))
);

CREATE INDEX IF NOT EXISTS ofs_staff_otp_exp_ix  ON ofs.ofs_staff_otp (expires_at);
CREATE INDEX IF NOT EXISTS ofs_staff_otp_user_ix ON ofs.ofs_staff_otp (user_id, issued_at DESC);
