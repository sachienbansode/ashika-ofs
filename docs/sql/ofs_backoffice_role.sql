-- ============================================================================
-- OFS-Backoffice role + one user.
--
-- RUN ON: the Ananta database (uat_ananta_staging) — this is where the platform
--         keeps users, roles and page_registry. NOT on ofs_bids.
-- RUN AS: a role that can write to the "admin-staging-api" schema.
--
-- These are the platform's OWN accounts. OFS never creates a login of its own; it
-- reads users/roles live on every request, so a change here takes effect within
-- ~15s without restarting anything.
--
-- SuperAdmin needs nothing from this file: its permissions are {"pages":["*"]},
-- and '*' is full access everywhere, including the OFS desk and PII unmasking.
-- ============================================================================

-- ---------------------------------------------------------------- 1. the pages
-- The OFS app registers these itself at startup (lib/pageRegistry.js). Repeated
-- here so the role can be created before the app has ever run against this DB.
INSERT INTO "admin-staging-api".page_registry (key, label, nav_ids, sort_order, is_active) VALUES
  ('ofs-desk',    'OFS · Bidding Desk',      ARRAY['n-ofs','w-ofs','n-ofs-desk'],    610, true),
  ('ofs-masters', 'OFS · Masters & Margins', ARRAY['n-ofs','w-ofs','n-ofs-masters'], 620, true)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label, nav_ids = EXCLUDED.nav_ids,
      sort_order = EXCLUDED.sort_order, is_active = true;

-- ----------------------------------------------------------------- 2. the role
-- Levels: view < edit < pii. 'ofs-desk:pii' is what lets a user see an unmasked
-- PAN/mobile in the bid book; drop it to ':edit' for a role that should not.
-- requires_mfa = true forces a one-time code at sign-in, portal and desk alike.
INSERT INTO "admin-staging-api".roles (name, description, is_system, requires_mfa, use_m365, permissions)
VALUES (
  'OFS-Backoffice',
  'Ashika OFS back office: bidding desk, exchange files, allotment, masters and margins.',
  false, false, false,
  '{"pages":["ofs-desk:pii","ofs-masters:edit"],"actions":["*"]}'::jsonb
)
ON CONFLICT (name) DO UPDATE
  SET permissions = EXCLUDED.permissions,
      description = EXCLUDED.description,
      updated_at  = NOW();

-- The built-in Admin role gets the desk too (read/write, PII still masked).
-- NOTE the ':edit'. A bare 'ofs-masters' is VIEW ONLY, and every save then fails
-- with {"error":"read_only"} — this block used to grant the bare form.
UPDATE "admin-staging-api".roles r
   SET permissions = jsonb_set(
         COALESCE(r.permissions, '{}'::jsonb), '{pages}',
         COALESCE((SELECT jsonb_agg(e)
                     FROM jsonb_array_elements_text(r.permissions->'pages') AS t(e)
                    WHERE split_part(e, ':', 1) NOT IN ('ofs-desk','ofs-masters')), '[]'::jsonb)
         || '["ofs-desk:edit","ofs-masters:edit"]'::jsonb, true),
       updated_at = NOW()
 WHERE r.name = 'Admin';

-- ----------------------------------------------------------------- 3. the user
-- password_hash is bcrypt, cost 12 — the same format the portal writes. Generate
-- one and paste it in place of the placeholder below:
--
--   node -e "require('bcryptjs').hash('<the password>',12).then(console.log)"
--
-- Never put the plaintext password in this file or in a commit.
INSERT INTO "admin-staging-api".users
  (email, first_name, last_name, password_hash, user_type, role_id, is_active, auth_provider, mfa_enabled, created_by)
SELECT
  'ofs.desk@ashikagroup.com',          -- <- the sign-in email
  'OFS', 'Desk',
  '$2b$12$REPLACE_WITH_A_GENERATED_BCRYPT_HASH',
  'internal',
  r.id,
  true,
  'password',
  false,                               -- true = also demand a one-time code
  'ofs-setup'
  FROM "admin-staging-api".roles r
 WHERE r.name = 'OFS-Backoffice'
ON CONFLICT (email) DO UPDATE
  SET role_id   = EXCLUDED.role_id,
      is_active = true,
      updated_at = NOW();

-- ------------------------------------------------------------------- 4. check
SELECT u.id, u.email, u.is_active, u.mfa_enabled, r.name AS role, r.requires_mfa,
       r.permissions->'pages' AS pages
  FROM "admin-staging-api".users u
  JOIN "admin-staging-api".roles r ON r.id = u.role_id
 WHERE r.name IN ('OFS-Backoffice','SuperAdmin','Admin')
 ORDER BY r.name, u.email;

-- To move an EXISTING person onto this role instead of creating an account:
-- UPDATE "admin-staging-api".users
--    SET role_id = (SELECT id FROM "admin-staging-api".roles WHERE name = 'OFS-Backoffice'),
--        updated_at = NOW()
--  WHERE lower(email) = lower('someone@ashikagroup.com');
