-- Client (and later AP) identity. A NEW path, deliberately separate from the staff
-- `users` table: clients are not platform users and must never appear there.
--
-- Security invariants carried over from the platform:
--   * OTP is stored as a HASH ONLY. Nothing here can reveal a code, to anyone.
--   * Attempts are capped and counted server-side, not in the client.
--   * A challenge is bound to the mobile+email it was issued for.

-- ---------------------------------------------------------------- OTP challenges
CREATE TABLE IF NOT EXISTS ofs.ofs_client_otp (
  ref          text PRIMARY KEY,              -- opaque handle given to the browser
  mobile       text        NOT NULL,          -- last-10 normalised, used for the match
  email        text        NOT NULL,
  uccs         text[]      NOT NULL,          -- the UCC(s) that matched, resolved at issue time
  otp_hash     text        NOT NULL,          -- sha256(code) - the code itself is never stored
  attempts     integer     NOT NULL DEFAULT 0,
  max_attempts integer     NOT NULL DEFAULT 5,
  delivered_to text,                          -- masked address, for display only
  channel      text        NOT NULL DEFAULT 'email',
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  ip           inet,
  user_agent   text,
  CONSTRAINT ofs_client_otp_channel_ck CHECK (channel IN ('email','sms','test'))
);
CREATE INDEX IF NOT EXISTS ofs_client_otp_exp_ix ON ofs.ofs_client_otp (expires_at);
CREATE INDEX IF NOT EXISTS ofs_client_otp_mob_ix ON ofs.ofs_client_otp (mobile, issued_at DESC);

-- ---------------------------------------------------------------- client sessions
-- The JWT in the cookie is the credential; this table exists so a session can be
-- revoked, listed and audited - a stateless token alone cannot be withdrawn.
CREATE TABLE IF NOT EXISTS ofs.ofs_client_session (
  jti         text PRIMARY KEY,
  client_ucc  text        NOT NULL,
  actor_type  text        NOT NULL DEFAULT 'client',   -- client | ap
  ap_id       text,                                     -- set when an AP acts for a client
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at  timestamptz,
  ip          inet,
  user_agent  text,
  CONSTRAINT ofs_client_session_actor_ck CHECK (actor_type IN ('client','ap'))
);
CREATE INDEX IF NOT EXISTS ofs_client_session_ucc_ix ON ofs.ofs_client_session (client_ucc, issued_at DESC);
CREATE INDEX IF NOT EXISTS ofs_client_session_live_ix ON ofs.ofs_client_session (expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- sign-in audit
-- Every attempt, successful or not, so a targeted guessing campaign is visible.
CREATE TABLE IF NOT EXISTS ofs.ofs_client_login_log (
  id         bigserial PRIMARY KEY,
  event      text NOT NULL,               -- otp_requested | otp_sent | otp_failed | login | logout | blocked
  mobile     text,                        -- normalised; never the full email+mobile pair in one readable place
  email      text,
  client_ucc text,
  ok         boolean NOT NULL DEFAULT false,
  reason     text,
  ip         inet,
  user_agent text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ofs_client_login_log_ix ON ofs.ofs_client_login_log (at DESC);
CREATE INDEX IF NOT EXISTS ofs_client_login_log_ip_ix ON ofs.ofs_client_login_log (ip, at DESC);
