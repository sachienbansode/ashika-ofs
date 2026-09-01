'use strict';
/**
 * Mirrors lib/pageRegistry.js in omnenest-uploader-api (REUSE.md 2). Add a key to
 * PAGES and it self-registers into the platform's page_registry on startup — no
 * per-page SQL, no drift between environments.
 *
 * The table is owned by the platform. Its real shape (verified 2026-09-01):
 *   key VARCHAR(50) PK, label VARCHAR(100) NOT NULL, nav_ids TEXT[],
 *   sort_order INT, is_active BOOLEAN, created_at TIMESTAMPTZ
 * There is NO `description` column, and nav_ids is a Postgres TEXT[] — pass a JS
 * array and let pg convert it, never JSON.stringify.
 */
const { T, adminQuery, adminRows } = require('../db/adminAdapter');

const PAGES = [
  {
    key: 'ofs-desk',
    label: 'OFS · Bidding Desk',
    nav_ids: ['n-ofs', 'w-ofs', 'n-ofs-desk'],
    sort_order: 610,
    grantToAdmin: true
  },
  {
    key: 'ofs-masters',
    label: 'OFS · Masters & Margins',
    nav_ids: ['n-ofs', 'w-ofs', 'n-ofs-masters'],
    sort_order: 620,
    grantToAdmin: true
  }
  // Phase 2: { key: 'ofs-client', ... }, { key: 'ofs-ap', ... }
];

async function registerPages() {
  let added = 0, refreshed = 0;

  for (const p of PAGES) {
    const rows = await adminRows(
      `INSERT INTO ${T('page_registry')} (key, label, nav_ids, sort_order, is_active)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (key) DO UPDATE
         SET label = EXCLUDED.label, nav_ids = EXCLUDED.nav_ids,
             sort_order = EXCLUDED.sort_order, is_active = true
       RETURNING (xmax = 0) AS inserted`,
      [p.key, p.label, p.nav_ids, p.sort_order]);

    const isNew = rows[0] && rows[0].inserted === true;
    if (isNew) added++; else refreshed++;

    // First registration only: also grant to the Admin role, so the page is
    // reachable without hand-editing a role. Guarded, so a page an admin has
    // deliberately removed is never silently re-added.
    if (isNew && p.grantToAdmin) {
      await adminQuery(
        `UPDATE ${T('roles')}
            SET permissions = jsonb_set(permissions, '{pages}',
                  (COALESCE(permissions->'pages','[]'::jsonb) || to_jsonb($1::text)), true),
                updated_at = NOW()
          WHERE name = 'Admin' AND NOT (permissions->'pages' @> to_jsonb($1::text))`,
        [p.key]).catch(() => {});
    }
  }

  console.log(`[page-registry] synced ${PAGES.length} pages (new: ${added}, refreshed: ${refreshed})`);
  return PAGES.map((p) => p.key);
}

module.exports = { PAGES, registerPages };
