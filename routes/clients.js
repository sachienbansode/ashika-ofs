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
const marginView = require('../lib/marginView');

const router = express.Router();
const PAGE = 'ofs-desk';

/* Margin + live exposure came from a copy of this query that lived here. It is now
 * lib/marginView, shared with the portal, so the desk's Clients screen and an AP's
 * show the same three figures computed the same way. */
const ofsSideFor = (uccs) => marginView.forUccs(uccs);

/**
 * The desk's client list — every client, searchable, with their margin.
 *
 * Same screen an AP gets at /client/api/me/clients over their own book. The desk's
 * scope is "everyone", so there is no scope clause here: requirePage is what stands
 * between a signed-in staff user and this list.
 */
router.get('/', requirePage(PAGE), async (req, res, next) => {
  try {
    const clients = await ld.search(req.query.q, req.query.limit);
    const merged = await marginView.attach(clients, 'ucc');
    res.json({
      clients: maskRows(merged, canViewPII(req, PAGE)),
      // Across the rows returned, not across every client on the platform — the
      // screen says so, because a total whose scope is unclear is worse than none.
      totals: marginView.totalsOf(merged),
      pii_unmasked: canViewPII(req, PAGE)
    });
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
