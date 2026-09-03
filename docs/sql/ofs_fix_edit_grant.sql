-- ============================================================================
-- "read_only" when saving an issue — diagnose and fix the page grant.
--
-- RUN ON: uat_ananta_staging  (the platform's users/roles live here, not ofs_bids)
-- RUN AS: a role that can write to the "admin-staging-api" schema.
--
-- Cause: pages are granted at a level — view < edit < pii. A bare 'ofs-masters'
-- entry means VIEW ONLY, so every POST/PUT is refused with {"error":"read_only"}.
-- Only 'ofs-masters:edit' (or '*') may write. The Admin role in the original
-- setup script was granted the bare form, which is exactly this symptom.
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
