'use strict';
/**
 * What a signed-in client can see and do. Every route is scoped to req.client.ucc:
 * a client can only ever read or write their own bids, never another account's.
 */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { requireClient } = require('../middleware/clientAuth');
const { issueStatus, catStatus, minPrice, validateBid } = require('../lib/domain');
const settings = require('../lib/settings');
const bids = require('../lib/bidService');
const audit = require('../lib/audit');
const ld = require('../db/ldAdapter');

const router = express.Router();
router.use(requireClient);

/** Open issues, as a client sees them: no desk aggregates, no other clients' bids. */
/**
 * The client's list of open issues.
 *
 * status = 'Auto' rather than "not Closed": a Suspended issue must not appear here.
 * That covers both a desk suspension and — the case that made this explicit — an
 * issue the circular watch created automatically, whose floor price and windows were
 * read out of a PDF and not yet checked by anyone. Showing a client a floor price of
 * 0.01 with invented dates would be worse than showing them nothing.
 */
router.get('/issues', async (req, res, next) => {
  try {
    const s = await settings.all();
    const list = await rows(
      `SELECT id, symbol, company, isin, exchange, floor_price, cut_price_min, tick, lot,
              discount_pct, cutoff_flag, hni_open, hni_close, ret_open, ret_close,
              indicative_ri, indicative_ni, status
         FROM ${SCHEMA}.ofs_issue
        WHERE archived_at IS NULL
          AND status = 'Auto'                 -- never Suspended, never Closed
          AND needs_review = false            -- never one the app created from a circular
          AND greatest(hni_close, ret_close) > now()
        ORDER BY greatest(hni_close, ret_close)`);

    const mine = await rows(
      `SELECT id, ref, issue_id, category, qty, price, is_cutoff, value, status, created_at
         FROM ${SCHEMA}.ofs_bid
        WHERE client_ucc = $1 AND status <> 'Cancelled'`, [req.client.ucc]);

    const now = new Date();
    res.json({
      server_time: now.toISOString(),
      settings: { retail_cap: s.retail_cap, hni_min: s.hni_min, daily_cutoff: s.daily_cutoff },
      issues: list.map((i) => Object.assign({}, i, {
        status_label: issueStatus(i, now),
        ret_status: catStatus(i, 'Retail', now),
        hni_status: catStatus(i, 'HNI', now),
        min_price_retail: minPrice(i, 'Retail'),
        min_price_hni: minPrice(i, 'HNI'),
        my_bid: mine.find((b) => String(b.issue_id) === String(i.id)) || null
      }))
    });
  } catch (e) { next(e); }
});

/** The client's own bids, and their margin. */
router.get('/me/bids', async (req, res, next) => {
  try {
    const b = await rows(
      `SELECT b.id, b.ref, b.issue_id, b.category, b.qty, b.price, b.is_cutoff, b.value,
              b.status, b.reject_reason, b.created_at, b.updated_at,
              i.symbol, i.company, i.ret_close, i.hni_close
         FROM ${SCHEMA}.ofs_bid b
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
        WHERE b.client_ucc = $1
        ORDER BY b.created_at DESC LIMIT 100`, [req.client.ucc]);

    const m = await one(
      `SELECT COALESCE(available,0) AS available FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`,
      [req.client.ucc]);
    const used = await one(
      `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
        WHERE client_ucc = $1 AND status = 'Live'`, [req.client.ucc]);

    const available = Number(m && m.available) || 0;
    const consumed = Number(used && used.v) || 0;
    res.json({ bids: b, margin: { available, used: consumed, free: available - consumed } });
  } catch (e) { next(e); }
});

/** Allotment results for this client, once the desk has imported them. */
router.get('/me/allotments', async (req, res, next) => {
  try {
    const a = await rows(
      `SELECT a.allot_qty, a.allot_price, a.allot_value, a.allotted_at,
              i.symbol, i.company
         FROM ${SCHEMA}.ofs_allotment a
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = a.issue_id
        WHERE a.client_ucc = $1
        ORDER BY a.allotted_at DESC LIMIT 50`, [req.client.ucc]);
    res.json({ allotments: a });
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------------- bidding --
 * A client places, modifies and cancels their OWN bid. Three things make this
 * safe to expose, and all three are enforced here rather than trusted:
 *
 *   the UCC is taken from the session, never from the body — a client cannot bid
 *   on another account by editing a request;
 *   every rule runs through lib/bidService, the same code the desk uses, so the
 *   margin gate, the SEBI retail cap, the floor and the cut-off cannot differ by
 *   which screen the bid came from;
 *   ownership is re-checked on the row itself before a modify or a cancel.
 *
 * placed_by records which of the two it was — the client themselves, or their AP
 * acting for them — because the bid book, the audit trail and the exchange file
 * all need to tell those apart.
 */
function placedBy(req) {
  return req.client.actorType === 'ap' ? 'ap' : 'client';
}
function placedById(req) {
  return req.client.actorType === 'ap' ? req.client.apId : req.client.ucc;
}

/** The body a client may send. Their UCC is not in it — the session decides that. */
function clientBid(req) {
  return bids.normalise(Object.assign({}, req.body, {
    client_ucc: req.client.ucc,
    cp_code: null, custody_code: null, exch_order_no: null   // desk-only fields
  }));
}

/** POST /client/api/bids/validate — dry run, so the screen can show the verdict. */
router.post('/bids/validate', async (req, res, next) => {
  try {
    const b = clientBid(req);
    if (!b.issue_id) return res.status(400).json({ error: 'missing_field', field: 'issue_id' });
    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, req.body.editingId || null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });
    if (req.body.editingId) b.editingId = req.body.editingId;
    const errs = validateBid(ctx.issue, b, ctx);
    res.json({
      ok: errs.length === 0,
      errors: errs,
      value: bids.bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff),
      min_price: minPrice(ctx.issue, b.category),
      available_margin: ctx.availableMargin,
      free_margin: ctx.availableMargin - ctx.marginUsed
    });
  } catch (e) { next(e); }
});

/** POST /client/api/bids — place. */
router.post('/bids', async (req, res, next) => {
  try {
    const b = clientBid(req);
    if (!b.issue_id) return res.status(400).json({ error: 'missing_field', field: 'issue_id' });

    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });
    // A client may only bid on an issue they can see: the same filter as /issues.
    if (ctx.issue.archived_at || ctx.issue.status !== 'Auto' || ctx.issue.needs_review) {
      return res.status(409).json({ error: 'issue_not_open',
        message: 'This offer is not open for bidding.' });
    }

    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    const r = await bids.insertBid(b, ctx, placedBy(req), placedById(req));
    await audit.log(req, 'place', 'ofs_bid', r.id, null, r);
    res.status(201).json({ bid: r });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'duplicate_live_bid',
        message: 'You already have a live bid on this offer. Modify it instead of placing another.' });
    }
    next(e);
  }
});

/** The client's own bid, or 404 — never another account's, and never "403". */
async function ownBid(req) {
  return one(`SELECT * FROM ${SCHEMA}.ofs_bid WHERE id = $1 AND client_ucc = $2`,
    [req.params.id, req.client.ucc]);
}

/** PUT /client/api/bids/:id — modify, allowed until the cut-off. */
router.put('/bids/:id(\\d+)', async (req, res, next) => {
  try {
    const before = await ownBid(req);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.status === 'Cancelled') return res.status(409).json({ error: 'already_cancelled' });

    const b = bids.mergeForModify(before, req.body || {});
    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, before.id);
    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    const r = await bids.updateBid(before, b, ctx, null);
    await audit.log(req, 'modify', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { next(e); }
});

/** DELETE /client/api/bids/:id — cancel. Never a hard delete: the row is the record. */
router.delete('/bids/:id(\\d+)', async (req, res, next) => {
  try {
    const before = await ownBid(req);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.status === 'Cancelled') return res.status(409).json({ error: 'already_cancelled' });

    // No force flag here. The desk may cancel after the cut-off with a reason on
    // record; a client may not.
    const blocked = await bids.cancelBlockedMessage();
    if (blocked) return res.status(422).json({ error: 'window_closed', message: blocked });

    const r = await bids.cancelBid(before, req.body && req.body.reason);
    await audit.log(req, 'cancel', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { next(e); }
});

module.exports = router;
