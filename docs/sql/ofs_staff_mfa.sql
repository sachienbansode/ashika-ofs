-- ============================================================================
-- Turn ON the emailed one-time code for OFS back-office sign-in.
--
-- RUN ON: uat_ananta_staging  (the platform's users/roles live here)
-- RUN AS: a role that can write to the "admin-staging-api" schema.
--
-- OFS already sends a real code by email — it uses the platform's own SMTP
-- settings, so there is nothing to configure — but it only asks for one when the
-- ROLE or the USER says multi-factor is required. Without this, a password alone
-- opens the desk.
--
-- Client-facing codes are unaffected: those stay on a fixed test code until Ashika
-- goes live (OFS_OTP_TEST_MODE), because UAT has no real client mailboxes.
-- ============================================================================

-- ----------------------------------------------------------- 1. WHERE ARE WE NOW
SELECT r.name AS role, r.requires_mfa, count(u.id) AS users
  FROM "admin-staging-api".roles r
  LEFT JOIN "admin-staging-api".users u ON u.role_id = r.id
 WHERE r.name IN ('OFS-Backoffice','Admin','SuperAdmin')
 GROUP BY r.name, r.requires_mfa
 ORDER BY r.name;

-- ------------------------------------------------------------------- 2. TURN IT ON
-- Every role that can reach OFS. The desk sees every client's PAN and mobile and
-- generates the files that go to the exchange; a password alone is not enough for
-- that, and MFA on the highest-privilege roles first is the wrong way round.
UPDATE "admin-staging-api".roles
   SET requires_mfa = true, updated_at = NOW()
 WHERE name IN ('OFS-Backoffice','Admin','SuperAdmin')
   AND COALESCE(requires_mfa, false) = false;

-- To demand it from ONE person instead of a whole role:
-- UPDATE "admin-staging-api".users SET mfa_enabled = true, updated_at = NOW()
--  WHERE lower(email) = lower('someone@ashikagroup.com');

-- --------------------------------------------------------------------- 3. CONFIRM
SELECT r.name AS role, r.requires_mfa, r.permissions->'pages' AS pages
  FROM "admin-staging-api".roles r
 WHERE r.name IN ('OFS-Backoffice','Admin','SuperAdmin')
 ORDER BY r.name;

-- No restart needed: roles are read live on every request.
--
-- Before running this, check that mail actually works — Masters → Settings shows
-- the SMTP status, and OFS reads smtp_settings from this same database. Turning MFA
-- on while mail is down locks the desk out of its own application: the code is
-- generated and emailed, and nothing arrives. If that happens, set
-- OFS_STAFF_OTP_TEST_MODE=true in the app's .env and restart to get back in, then
-- fix the mail and set it back to false.
