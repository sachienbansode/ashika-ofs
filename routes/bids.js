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
const dbErr = require('../lib/dbErrors');
const bidOtp = require('../lib/bidOtp');
const settings = require('../lib/settings');

const router = express.Router();
const PAGE = 'ofs-desk';

const BID_COLS = `b.id, b.ref, b.issue_id, b.client_ucc, b.cp_code, b.custody_code, b.category,
  b.placed_by, b.placed_by_id, b.branch_code, b.qty, b.price, b.is_cutoff, b.value, b.status,
  b.reject_reason, b.exch_order_no, b.otp_verified, b.created_at, b.updated_at`;

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
    if (req.query.branch_code) {
      p.push(String(req.query.branch_code).trim().toUpperCase());
      w.push('upper(b.branch_code) = $' + p.length);
    }
    // As-on date: the bid book as it stood on a given trading day. Compared in IST,
    // because the server runs UTC and "today" there starts at 05:30 here.
    if (req.query.as_on) {
      p.push(String(req.query.as_on).slice(0, 10));
      w.push(`(b.created_at AT TIME ZONE 'Asia/Kolkata')::date = $${p.length}::date`);
    }
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
    // A bid placed before branch stamping, or by the desk before the client's branch
    // was known, still shows a branch: fall back to the client's current one rather
    // than an empty column.
    for (const row of merged) {
      row.branch_code = row.branch_code || row.branch_id || null;
    }
    res.json({ bids: maskRows(merged, canViewPII(req, PAGE)), pii_unmasked: canViewPII(req, PAGE) });
  } catch (e) { next(e); }
});

/**
 * Is the client's confirmation required for this write?
 *
 * Every bid the desk places is a bid on someone else's behalf, so the answer is
 * normally yes. The setting exists because a desk cannot be left unable to work if
 * mail is down — but turning it off removes the only record that the client agreed,
 * which is the record that matters if they later say they did not.
 */
async function otpRequired() {
  const s = await settings.all();
  return String(s.bid_otp_required == null ? '1' : s.bid_otp_required) === '1';
}

/**
 * POST /api/bids/otp { issue_id, client_ucc, action, bid_id }
 * Sends a confirmation code to the CLIENT's registered contacts, not to the desk.
 */
router.post('/otp', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const b = req.body || {};
    const ucc = String(b.client_ucc || '').trim().toUpperCase();
    const action = String(b.action || 'place');
    if (!ucc || !b.issue_id) return res.status(400).json({ error: 'missing_field',
      message: 'A client UCC and an issue are needed to send a confirmation code.' });

    const issue = await one(`SELECT symbol, company FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [b.issue_id]);
    if (!issue) return res.status(404).json({ error: 'unknown_issue' });

    const r = await bidOtp.create({
      clientUcc: ucc, issueId: b.issue_id, action, bidId: b.bid_id,
      requestedBy: 'Ashika OFS desk (' + (req.user.email || req.user.id) + ')',
      requestedByKind: 'desk',
      issueLabel: issue.symbol + (issue.company ? ' — ' + issue.company : ''),
      detail: b.detail, ip: req.ip, userAgent: req.headers['user-agent']
    });
    if (!r.ok) return res.status(r.reason === 'unknown_client' ? 404 : 422).json({
      error: r.reason, message: r.message || 'Could not send a confirmation code.' });

    await audit.log(req, 'bid_otp_sent', 'ofs_bid', b.bid_id || null, null,
      { ucc, issue_id: b.issue_id, action, sent_to: r.sent_to });
    res.json(r);
  } catch (e) { next(e); }
});

/** Record WHICH confirmation authorised a bid, so one bid's history can be answered. */
async function markConfirmed(bidId, otpRef) {
  if (!bidId || !otpRef) return;
  await one(`UPDATE ${SCHEMA}.ofs_bid SET otp_verified = true, otp_ref = $2 WHERE id = $1 RETURNING id`,
    [bidId, String(otpRef)]).catch(() => {});
}

/** Redeem, or explain. Returns null when the write may proceed. */
async function confirmOrReject(req, res, { ucc, issueId, action, bidId }) {
  if (!(await otpRequired())) return null;
  const body = req.body || {};
  if (!body.otp_ref || !body.otp) {
    return res.status(428).json({
      error: 'otp_required',
      message: 'This bid is on a client\'s behalf, so the client must confirm it. '
             + 'Send them a code, then enter it here.',
      action, client_ucc: ucc, issue_id: issueId
    });
  }
  const v = await bidOtp.verify({ ref: body.otp_ref, code: String(body.otp).replace(/\D/g, ''),
    clientUcc: ucc, issueId, action, bidId });
  if (!v.ok) {
    return res.status(401).json({ error: v.reason, message: bidOtp.message(v.reason),
      attempts_left: v.attemptsLeft });
  }
  return null;
}

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

    // Validate FIRST, confirm second: a client should not be asked to approve a bid
    // that was never going to pass the margin or cut-off check anyway.
    if (await confirmOrReject(req, res, { ucc: b.client_ucc, issueId: b.issue_id, action: 'place' })) return;

    const r = await bids.insertBid(b, ctx, 'desk', req.user.email || req.user.id, ctx.client.branch);
    await markConfirmed(r.id, req.body && req.body.otp_ref);

    await audit.log(req, 'place', 'ofs_bid', r.id, null, r);
    res.status(201).json({ bid: r });
  } catch (e) { dbErr.send(res, next, e); }
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

    if (await confirmOrReject(req, res,
      { ucc: before.client_ucc, issueId: before.issue_id, action: 'modify', bidId: before.id })) return;

    const r = await bids.updateBid(before, b, ctx, req.body.exch_order_no);
    await markConfirmed(r.id, req.body && req.body.otp_ref);

    await audit.log(req, 'modify', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { dbErr.send(res, next, e); }
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

    // Withdrawing a client's bid is as much theirs to agree to as placing one.
    if (await confirmOrReject(req, res,
      { ucc: before.client_ucc, issueId: before.issue_id, action: 'cancel', bidId: before.id })) return;

    const r = await bids.cancelBid(before, req.body && req.body.reason);
    await markConfirmed(r.id, req.body && req.body.otp_ref);
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
