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
    /* Ten at a time, paged in SQL. This used to take a `limit` and return that
     * many rows with no offset and no total: the desk saw the first hundred
     * clients of tens of thousands, the pager could not be drawn because nothing
     * said how many there were, and the only way to reach client number 101 was to
     * guess a narrower search. Same shape the partner endpoint has always
     * returned, so one screen renders both. */
    const page = await ld.searchPage(req.query.q, req.query.limit || 10, req.query.offset);
    /* `active`, spelled the way the screen reads it.
     *
     * The comment above says this endpoint returns the same shape as the partner
     * one so that a single screen renders both. It did not. The partner endpoint
     * builds each row by hand and sets `active`; this one hands back the client
     * record, which carries `is_active`. The table reads `c.active`, so on the
     * desk it was undefined on every row - and undefined is falsy, so EVERY client
     * was labelled Inactive and had its Place bid button replaced with "cannot
     * bid", however active they actually were. Nothing was refused by it; the bid
     * path never looked at this field. It was purely a screen telling the desk the
     * opposite of the truth. */
    const merged = (await marginView.attach(page.clients, 'ucc'))
      .map((c) => Object.assign({}, c, { active: c.is_active === true }));
    res.json({
      clients: maskRows(merged, canViewPII(req, PAGE)),
      total: page.total, limit: page.limit, offset: page.offset,
      q: String(req.query.q || '').trim() || null,
      // Across the rows on THIS page, not across every client on the platform —
      // the screen says which, because a total whose scope is unclear is worse
      // than none.
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
        available_margin: available, margin_at: side.margin_at || null,
        // Both spellings, for the same reason as the list above.
        active: client.is_active === true
      }), canViewPII(req, PAGE)),
      margin_used: used,
      free_margin: available - used,
      bids,
      pii_unmasked: canViewPII(req, PAGE)
    });
  } catch (e) { next(e); }
});

module.exports = router;
