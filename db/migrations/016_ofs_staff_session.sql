-- ============================================================================
-- OFS keeps its own back-office sessions.
--
-- Until now OFS and the Stage API portal both rotated "admin-staging-api".users
-- .active_sid, which is ONE column shared by two applications: signing in to OFS
-- ended the portal session and signing in to the portal ended OFS. Users read that
-- as being randomly logged out, because that is what it was.
--
-- The session now lives here, in the OFS database, and users.active_sid is left
-- alone for the portal to use as it always has. Nothing in the platform schema
-- changes, so the Stage API needs no coordination.
--
-- What is NOT lost: OFS reloads the user, the role and its page grants from the
-- platform on every request (15s cache), so a disabled account or a withdrawn grant
-- still dies within seconds. What IS lost, deliberately: a portal sign-in no longer
-- force-ends an OFS session. That cross-kill was the bug being reported.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ofs.ofs_staff_session (
  jti          text PRIMARY KEY,
  user_id      bigint      NOT NULL,
  email        text        NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_why  text,                        -- logout | superseded | idle
  ip           text,
  user_agent   text
);

-- "Is this session still good?" runs on every request; "end this user's other
-- sessions" runs on every sign-in. Both want the same index.
CREATE INDEX IF NOT EXISTS ofs_staff_session_user_ix
  ON ofs.ofs_staff_session (user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS ofs_staff_session_live_ix
  ON ofs.ofs_staff_session (expires_at) WHERE revoked_at IS NULL;
