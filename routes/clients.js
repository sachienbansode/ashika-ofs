'use strict';
/**
 * Client lookups. Read-through to LD in the Ananta database via ldAdapter, joined
 * in the app to the OFS margin snapshot (different database — no SQL join possible).
 * PII is masked unless the viewer holds an explicit unmask grant.
 */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const ld = require('../db/ldAdapter');
const { requirePage, canViewPII } = require('../middleware/pageAccess');
const { maskRow, maskRows } = require('../lib/pii');

const router = express.Router();
const PAGE = 'ofs-desk';

/** Margin + live exposure for a set of UCCs, from the OFS database. */
async function ofsSideFor(uccs) {
  const list = Array.from(new Set((uccs || []).map(ld.norm).filter(Boolean)));
  const out = new Map();
  if (!list.length) return out;
  const r = await rows(
    `SELECT COALESCE(m.client_ucc, u.client_ucc)      AS client_ucc,
            COALESCE(m.available, 0)                 AS available_margin,
            m.updated_at                             AS margin_at,
            COALESCE(u.used, 0)                      AS margin_used
       FROM ${SCHEMA}.ofs_margin m
       FULL JOIN (SELECT client_ucc, sum(value) AS used
                    FROM ${SCHEMA}.ofs_bid WHERE status = 'Live' GROUP BY client_ucc) u
         ON u.client_ucc = m.client_ucc
      WHERE COALESCE(m.client_ucc, u.client_ucc) = ANY($1)`, [list]);
  for (const row of r) out.set(row.client_ucc, row);
  return out;
}

router.get('/', requirePage(PAGE), async (req, res, next) => {
  try {
    const clients = await ld.search(req.query.q, req.query.limit);
    const side = await ofsSideFor(clients.map((c) => c.ucc));
    const merged = clients.map((c) => {
      const s = side.get(c.ucc) || {};
      const available = Number(s.available_margin) || 0;
      const used = Number(s.margin_used) || 0;
      return Object.assign({}, c, {
        available_margin: available, margin_used: used,
        free_margin: available - used, margin_at: s.margin_at || null
      });
    });
    res.json({ clients: maskRows(merged, canViewPII(req, PAGE)), pii_unmasked: canViewPII(req, PAGE) });
  } catch (e) { next(e); }
});

router.get('/:ucc', requirePage(PAGE), async (req, res, next) => {
  try {
    const ucc = ld.norm(req.params.ucc);
    const client = await ld.findByUcc(ucc);
    if (!client) return res.status(404).json({ error: 'not_found' });

    const side = (await ofsSideFor([ucc])).get(ucc) || {};
    const available = Number(side.available_margin) || 0;
    const used = Number(side.margin_used) || 0;

    const bids = await rows(
      `SELECT id, ref, issue_id, category, qty, price, is_cutoff, value, status, created_at
         FROM ${SCHEMA}.ofs_bid WHERE client_ucc = $1 ORDER BY created_at DESC LIMIT 50`, [ucc]);

    res.json({
      client: maskRow(Object.assign({}, client, {
        available_margin: available, margin_at: side.margin_at || null
      }), canViewPII(req, PAGE)),
      margin_used: used,
      free_margin: available - used,
      bids,
      pii_unmasked: canViewPII(req, PAGE)
    });
  } catch (e) { next(e); }
});

module.exports = router;
