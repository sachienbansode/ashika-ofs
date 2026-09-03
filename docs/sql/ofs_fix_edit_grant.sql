-- ============================================================================
-- "read_only" when saving an issue — diagnose and fix the page grant.
--
-- RUN ON: uat_ananta_staging  (the platform's users/roles live here, not ofs_bids)
-- RUN AS: a role that can write to the "admin-staging-api" schema.
--
-- Cause: pages used to be graded view < edit < pii, and a bare 'ofs-masters' entry
-- meant VIEW ONLY — so every POST/PUT came back {"error":"read_only"}. The Admin
-- role in the original setup script was granted exactly that bare form.
--
-- The rule has since changed to match how Ashika runs the desk: whoever has OFS
-- access has FULL OFS access, so any OFS entry at any level now writes, and sees
-- unmasked client PII. On an app carrying that change this script is no longer
-- needed — it is kept because it also normalises the stored grants, and because a
-- database is often older than the code pointed at it.
-- ============================================================================

-- ------------------------------------------------------- 1. WHO AM I SIGNED IN AS
-- Run this first. If the role's pages show 'ofs-masters' without ':edit',
-- that is the whole problem.
SELECT u.email, u.is_active, r.name AS role, r.permissions->'pages' AS pages
  FROM "admin-staging-api".users u
  JOIN "admin-staging-api".roles r ON r.id = u.role_id
 WHERE r.permissions::text LIKE '%ofs-%' OR r.permissions->'pages' @> '["*"]'
 ORDER BY r.name, u.email;

-- ------------------------------------------------------------------- 2. THE FIX
-- Rebuilds the pages array: keeps every non-OFS grant untouched, drops any OFS
-- entry at any level, then adds the levelled ones back. Safe to run twice.

-- OFS-Backoffice: full desk including unmasked PII, and edit on masters.
UPDATE "admin-staging-api".roles r
   SET permissions = jsonb_set(
         COALESCE(r.permissions, '{}'::jsonb), '{pages}',
         COALESCE((SELECT jsonb_agg(e)
                     FROM jsonb_array_elements_text(r.permissions->'pages') AS t(e)
                    WHERE split_part(e, ':', 1) NOT IN ('ofs-desk','ofs-masters')), '[]'::jsonb)
         || '["ofs-desk:pii","ofs-masters:edit"]'::jsonb, true),
       updated_at = NOW()
 WHERE r.name = 'OFS-Backoffice';

-- Admin: desk and masters read/write, PII still masked.
UPDATE "admin-staging-api".roles r
   SET permissions = jsonb_set(
         COALESCE(r.permissions, '{}'::jsonb), '{pages}',
         COALESCE((SELECT jsonb_agg(e)
                     FROM jsonb_array_elements_text(r.permissions->'pages') AS t(e)
                    WHERE split_part(e, ':', 1) NOT IN ('ofs-desk','ofs-masters')), '[]'::jsonb)
         || '["ofs-desk:edit","ofs-masters:edit"]'::jsonb, true),
       updated_at = NOW()
 WHERE r.name = 'Admin';

-- SuperAdmin needs nothing: '*' is full access everywhere, PII included.

-- ----------------------------------------------------------------- 3. CONFIRM
SELECT r.name AS role, r.permissions->'pages' AS pages, r.updated_at
  FROM "admin-staging-api".roles r
 WHERE r.name IN ('OFS-Backoffice','Admin','SuperAdmin')
 ORDER BY r.name;

-- No restart needed. OFS reads users and roles live on every request, so the
-- change takes effect on the next click — sign out and in if the page was
-- already open, so the screen re-reads the grants.
