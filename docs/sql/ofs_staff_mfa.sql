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


-- --------------------------------------------------------------- 0. RIGHT DB?
-- A comment at the top of a long script is scrolled past. This is not: it fails
-- on line 1 and names the database you should be on, instead of letting you get
-- eighteen lines in and reading "relation ... does not exist", which sounds like
-- the table is missing rather than like you are in the wrong place.
DO $guard$
BEGIN
  IF to_regclass('"admin-staging-api".roles') IS NULL THEN
    RAISE EXCEPTION 'Wrong database: this script must run on uat_ananta_staging, not %.',
                    current_database()
      USING HINT = 'The platform keeps users, roles and page_registry in uat_ananta_staging. '
                   'ofs_bids holds only the OFS tables. Reconnect pgAdmin to uat_ananta_staging '
                   '(Servers > ... > Databases > uat_ananta_staging), open the Query Tool there, '
                   'and run this script again.';
  END IF;
END
$guard$;

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

-- ------------------------------------------------------------ 4. IF YOU ARE LOCKED OUT
-- Symptom: the password is accepted, then "We could not send your code just now."
-- That is mail, not the password. On the app server:
--
--     cd /var/apps/ashika-ofs-app && npm run check-mail
--
-- It names which of the four things is wrong — no SMTP row, no host, a password that
-- will not decrypt (API_KEY_SECRET here differs from the portal's, the most common
-- cause), or the SMTP server itself refusing. To get back in meanwhile:
--
--     echo 'OFS_STAFF_OTP_TEST_MODE=true' >> .env && pm2 restart ashika-ofs-app
--
-- ...then fix the mail and set it back to false. Or turn MFA off again:
--
--     UPDATE "admin-staging-api".roles SET requires_mfa = false
--      WHERE name IN ('OFS-Backoffice','Admin','SuperAdmin');

-- No restart needed: roles are read live on every request.
--
-- Before running this, check that mail actually works — Masters → Settings shows
-- the SMTP status, and OFS reads smtp_settings from this same database. Turning MFA
-- on while mail is down locks the desk out of its own application: the code is
-- generated and emailed, and nothing arrives. If that happens, set
-- OFS_STAFF_OTP_TEST_MODE=true in the app's .env and restart to get back in, then
-- fix the mail and set it back to false.
