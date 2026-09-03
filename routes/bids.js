'use strict';
/** Bid book: list, place, modify, cancel. Server enforces every prototype rule. */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const ld = require('../db/ldAdapter');
const { requirePage, requireEdit, canViewPII } = require('../middleware/pageAccess');
const { maskRows } = require('../lib/pii');
const { validateBid, bidValue, minPrice } = require('../lib/domain');
const bids = require('../lib/bidService');
const audit = require('../lib/audit');

const router = express.Router();
const PAGE = 'ofs-desk';

const BID_COLS = `b.id, b.ref, b.issue_id, b.client_ucc, b.cp_code, b.custody_code, b.category,
  b.placed_by, b.placed_by_id, b.qty, b.price, b.is_cutoff, b.value, b.status, b.reject_reason,
  b.exch_order_no, b.otp_verified, b.created_at, b.updated_at`;

const ISSUE_JOIN = `LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id`;
const ISSUE_SEL = `i.symbol, i.company, i.isin, i.exchange, i.floor_price, i.cut_price_min, i.tick, i.lot`;

/** GET /api/bids?issue_id=&category=&status=&q=&limit=&offset= */
router.get('/', requirePage(PAGE), async (req, res, next) => {
  try {
    const w = [], p = [];
    if (req.query.issue_id) { p.push(req.query.issue_id); w.push('b.issue_id = $' + p.length); }
    if (req.query.category) { p.push(req.query.category); w.push('b.category = $' + p.length); }
    if (req.query.status)   { p.push(req.query.status);   w.push('b.status = $' + p.length); }
    else if (String(req.query.include_cancelled || '') !== '1') w.push("b.status <> 'Cancelled'");
    if (req.query.q) {
      p.push('%' + String(req.query.q).trim().toUpperCase() + '%');
      w.push('(upper(b.client_ucc) LIKE $' + p.length + ' OR upper(i.symbol) LIKE $' + p.length + ' OR upper(b.ref) LIKE $' + p.length + ')');
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Number(req.query.offset) || 0;
    p.push(limit); p.push(offset);

    const r = await rows(
      `SELECT ${BID_COLS}, ${ISSUE_SEL}
         FROM ${SCHEMA}.ofs_bid b
         ${ISSUE_JOIN}
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
        ORDER BY b.created_at DESC
        LIMIT $${p.length - 1} OFFSET $${p.length}`, p);

    // client identity lives in the other database - one extra round trip, not a join
    const merged = await ld.enrich(r, 'client_ucc');
    res.json({ bids: maskRows(merged, canViewPII(req, PAGE)), pii_unmasked: canViewPII(req, PAGE) });
  } catch (e) { next(e); }
});

/** POST /api/bids - place on behalf of a client. */
router.post('/', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const b = bids.normalise(req.body || {});
    if (!b.issue_id || !b.client_ucc) return res.status(400).json({ error: 'missing_field' });

    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, null);
    if (!ctx.client.found) return res.status(404).json({ error: 'unknown_client', ucc: b.client_ucc });
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });

    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    const r = await bids.insertBid(b, ctx, 'desk', req.user.email || req.user.id);

    await audit.log(req, 'place', 'ofs_bid', r.id, null, r);
    res.status(201).json({ bid: r });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'duplicate_live_bid' });
    next(e);
  }
});

/** PUT /api/bids/:id - modify qty / price within the window. */
router.put('/:id', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const before = await one(`SELECT * FROM ${SCHEMA}.ofs_bid WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.status === 'Cancelled') return res.status(409).json({ error: 'already_cancelled' });

    const b = bids.mergeForModify(before, req.body || {});
    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, before.id);
    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    const r = await bids.updateBid(before, b, ctx, req.body.exch_order_no);

    await audit.log(req, 'modify', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { next(e); }
});

/** DELETE /api/bids/:id - cancel (never a hard delete; the row is the audit trail). */
router.delete('/:id', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const before = await one(`SELECT * FROM ${SCHEMA}.ofs_bid WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.status === 'Cancelled') return res.status(409).json({ error: 'already_cancelled' });

    // Modify was already gated through validateBid; cancel was not, so a bid could
    // be withdrawn after the desk had generated and uploaded the file.
    const blocked = await bids.cancelBlockedMessage();
    if (blocked && String(req.body && req.body.force) !== 'true') {
      return res.status(422).json({ error: 'window_closed', message: blocked });
    }

    const r = await bids.cancelBid(before, req.body && req.body.reason);
    await audit.log(req, 'cancel', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { next(e); }
});

/** POST /api/bids/validate - dry-run for the UI, no write. */
router.post('/validate', requirePage(PAGE), async (req, res, next) => {
  try {
    const b = bids.normalise(req.body || {});
    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, req.body.editingId || null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });
    if (req.body.editingId) b.editingId = req.body.editingId;
    const errs = validateBid(ctx.issue, b, ctx);
    res.json({
      ok: errs.length === 0,
      errors: errs,
      value: bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff),
      min_price: minPrice(ctx.issue, b.category),
      available_margin: ctx.availableMargin,
      free_margin: ctx.availableMargin - ctx.marginUsed,
      client_active: ctx.client.active
    });
  } catch (e) { next(e); }
});

module.exports = router;
