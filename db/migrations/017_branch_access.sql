-- ============================================================================
-- Branch and Authorised Partner access.
--
-- A branch signs in with the email on its LD branchho record and a one-time code,
-- and may then act for the clients whose ask_clientmast.BRANCH_ID is its
-- BRANCHCODE. Eligibility is read live from LD on every request — this schema
-- holds only what LD cannot: the desk's override, and the session.
-- ============================================================================

-- ------------------------------------------------------- the desk's override
-- Deliberately subtractive. A row here can stop an ACTIVE branch from signing in;
-- nothing here can let an inactive one in, or add a client to a branch. LD stays
-- the source of truth for who exists and who is active.
CREATE TABLE IF NOT EXISTS ofs.ofs_branch_setting (
  branch_code   text PRIMARY KEY,
  login_enabled boolean     NOT NULL DEFAULT true,
  note          text,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- the session
-- ofs_client_session now carries three kinds of actor:
--   client  — signed in as themselves, bound to one UCC
--   ap      — an Authorised Partner branch (branchho BRANCHTYPE = 'AP')
--   branch  — any other active branch of the firm
-- An AP/branch session is bound to a BRANCH, not to one client, so client_ucc
-- must be allowed to be empty for those.
ALTER TABLE ofs.ofs_client_session ADD COLUMN IF NOT EXISTS branch_code text;
ALTER TABLE ofs.ofs_client_session ADD COLUMN IF NOT EXISTS branch_name text;
ALTER TABLE ofs.ofs_client_session ADD COLUMN IF NOT EXISTS login_email text;
ALTER TABLE ofs.ofs_client_session ALTER COLUMN client_ucc DROP NOT NULL;

ALTER TABLE ofs.ofs_client_session DROP CONSTRAINT IF EXISTS ofs_client_session_actor_ck;
ALTER TABLE ofs.ofs_client_session ADD CONSTRAINT ofs_client_session_actor_ck
  CHECK (actor_type IN ('client','ap','branch'));

-- Each kind must carry what identifies it. Without this a branch session with no
-- branch_code would be a session scoped to nothing, which reads as scoped to
-- everything the first time someone writes a query that forgets to check.
ALTER TABLE ofs.ofs_client_session DROP CONSTRAINT IF EXISTS ofs_client_session_scope_ck;
ALTER TABLE ofs.ofs_client_session ADD CONSTRAINT ofs_client_session_scope_ck
  CHECK (
    (actor_type = 'client' AND client_ucc  IS NOT NULL AND btrim(client_ucc)  <> '')
    OR
    (actor_type IN ('ap','branch') AND branch_code IS NOT NULL AND btrim(branch_code) <> '')
  );

CREATE INDEX IF NOT EXISTS ofs_client_session_branch_ix
  ON ofs.ofs_client_session (branch_code, issued_at DESC) WHERE branch_code IS NOT NULL;

-- --------------------------------------------------------------- the OTP
-- The same one-time-code table serves branches. An email can appear against more
-- than one branchcode (a regional manager's address does), so the candidates are
-- resolved at issue time and kept as an array, exactly as client UCCs already are —
-- the browser then chooses from what was already decided, never from what it sends.
ALTER TABLE ofs.ofs_client_otp ADD COLUMN IF NOT EXISTS branch_codes text[];
ALTER TABLE ofs.ofs_client_otp ADD COLUMN IF NOT EXISTS actor_type text NOT NULL DEFAULT 'client';
ALTER TABLE ofs.ofs_client_otp DROP CONSTRAINT IF EXISTS ofs_client_otp_actor_ck;
ALTER TABLE ofs.ofs_client_otp ADD CONSTRAINT ofs_client_otp_actor_ck
  CHECK (actor_type IN ('client','branch'));

-- A branch signs in by email and has no mobile to match on, so the NOT NULL that
-- made sense for a client sign-in has to go. The columns stay, and stay filled for
-- a client.
ALTER TABLE ofs.ofs_client_otp ALTER COLUMN mobile DROP NOT NULL;
ALTER TABLE ofs.ofs_client_otp ALTER COLUMN uccs   DROP NOT NULL;

-- ------------------------------------------------------------- placed_by
-- A bid placed by a branch that is not an AP was previously unrepresentable.
ALTER TABLE ofs.ofs_bid DROP CONSTRAINT IF EXISTS ofs_bid_by_ck;
ALTER TABLE ofs.ofs_bid ADD CONSTRAINT ofs_bid_by_ck
  CHECK (placed_by IN ('desk','client','ap','branch'));

-- The branch a bid was placed for, stamped at placement. LD's BRANCH_ID can be
-- changed later; a bid file already sent to an exchange cannot, so the bid book
-- must remember the branch as it was, not as it is now.
ALTER TABLE ofs.ofs_bid ADD COLUMN IF NOT EXISTS branch_code text;
CREATE INDEX IF NOT EXISTS ofs_bid_branch_ix ON ofs.ofs_bid (branch_code, created_at DESC);
