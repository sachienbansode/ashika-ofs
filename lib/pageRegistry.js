'use strict';
/**
 * pageRegistry - mirrors lib/pageRegistry.js (REUSE.md 2). Add a key to PAGES and it
 * self-registers into the platform page_registry on startup - no per-page SQL.
 * Phase 1 registers ofs-desk; ofs-client / ofs-ap land in Phase 2.
 */
const { T, adminQuery } = require('../db/adminAdapter');

const PAGES = [
  {
    key: 'ofs-desk',
    label: 'OFS Desk',
    description: 'Real-time OFS bidding dashboard, bid book and NSE/BSE bid-file export',
    nav_ids: ['ofs'],
    sort_order: 610,
    grantToAdmin: true
  },
  {
    key: 'ofs-masters',
    label: 'OFS Masters',
    description: 'OFS issue master, margin ledger and desk settings',
    nav_ids: ['ofs'],
    sort_order: 620,
    grantToAdmin: true
  }
  // Phase 2: { key: 'ofs-client', ... }, { key: 'ofs-ap', ... }
];

async function registerPages() {
  for (const p of PAGES) {
    await adminQuery(
      `INSERT INTO ${T('page_registry')} (key, label, description, nav_ids, sort_order)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (key) DO UPDATE
         SET label = EXCLUDED.label,
             description = EXCLUDED.description,
             nav_ids = EXCLUDED.nav_ids,
             sort_order = EXCLUDED.sort_order`,
      [p.key, p.label, p.description, JSON.stringify(p.nav_ids), p.sort_order]
    );
  }
  return PAGES.map((p) => p.key);
}

module.exports = { PAGES, registerPages };
