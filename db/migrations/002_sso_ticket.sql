-- Single-use SSO tickets.
-- The portal mints a short-lived ticket and redirects the browser here; this table
-- is what makes it single-use. A ticket in a browser history entry, a proxy log or
-- a Referer header is worthless once redeemed.

CREATE TABLE IF NOT EXISTS ofs.ofs_sso_ticket (
  jti         text PRIMARY KEY,
  user_id     text        NOT NULL,
  email       text,
  issued_at   timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  ip          inet
);

-- Tickets live ~60s; keep a short trail for audit, then discard.
CREATE INDEX IF NOT EXISTS ofs_sso_ticket_exp_ix ON ofs.ofs_sso_ticket (expires_at);
