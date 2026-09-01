'use strict';
/** Bid book: list, place, modify, cancel. Server enforces every prototype rule. */
const express = require('express');
const { SCHEMA, rows, one, query, tx } = require('../db/ofsAdapter');
const { requirePage, requireEdit, canViewPII } = require('../middleware/pageAccess');
const { maskRows } = require('../lib/pii');
const settings = require('../lib/settings');
const { validateBid, bidValue, minPrice, makeRef } = require('../lib/domain');
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
      `SELECT ${BID_COLS}, ${ISSUE_SEL}, c.name AS client_name, c.pan, c.mobile, c.email
         FROM ${SCHEMA}.ofs_bid b
         ${ISSUE_JOIN}
         LEFT JOIN ${SCHEMA}.ofs_client c ON c.ucc = b.client_ucc
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
        ORDER BY b.created_at DESC
        LIMIT $${p.length - 1} OFFSET $${p.length}`, p);

    res.json({ bids: maskRows(r, canViewPII(req, PAGE)), pii_unmasked: canViewPII(req, PAGE) });
  } catch (e) { next(e); }
});

async function loadContext(issueId, ucc, editingId) {
  const s = await settings.all();
  const issue = await one(`SELECT * FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [issueId]);
  const margin = await one(`SELECT available FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`, [ucc]);
  const used = await one(
    `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
      WHERE client_ucc = $1 AND status = 'Live' ${editingId ? 'AND id <> $2' : ''}`,
    editingId ? [ucc, editingId] : [ucc]);
  const usedIssue = await one(
    `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
      WHERE client_ucc = $1 AND issue_id = $2 AND status = 'Live' ${editingId ? 'AND id <> $3' : ''}`,
    editingId ? [ucc, issueId, editingId] : [ucc, issueId]);
  const live = await one(
    `SELECT id FROM ${SCHEMA}.ofs_bid WHERE client_ucc = $1 AND issue_id = $2 AND status = 'Live'
      ${editingId ? 'AND id <> $3' : ''}`,
    editingId ? [ucc, issueId, editingId] : [ucc, issueId]);
  return {
    settings: s, issue,
    availableMargin: Number(margin && margin.available) || 0,
    marginUsed: Number(used && used.v) || 0,
    usedValueThisIssue: Number(usedIssue && usedIssue.v) || 0,
    hasLiveBid: !!live
  };
}

function normalise(body) {
  return {
    issue_id: body.issue_id,
    client_ucc: String(body.client_ucc || '').trim().toUpperCase(),
    category: body.category,
    qty: Number(body.qty) || 0,
    is_cutoff: !!body.is_cutoff,
    price: body.is_cutoff ? null : Number(body.price) || 0,
    cp_code: body.cp_code || null,
    custody_code: body.custody_code || null,
    exch_order_no: body.exch_order_no || null
  };
}

/** POST /api/bids - place on behalf of a client. */
router.post('/', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const b = normalise(req.body || {});
    if (!b.issue_id || !b.client_ucc) return res.status(400).json({ error: 'missing_field' });

    const client = await one(`SELECT ucc FROM ${SCHEMA}.ofs_client WHERE ucc = $1`, [b.client_ucc]);
    if (!client) return res.status(404).json({ error: 'unknown_client', ucc: b.client_ucc });

    const ctx = await loadContext(b.issue_id, b.client_ucc, null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });

    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    const value = bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff);
    const r = await one(
      `INSERT INTO ${SCHEMA}.ofs_bid
         (ref, issue_id, client_ucc, cp_code, custody_code, category, placed_by, placed_by_id,
          qty, price, is_cutoff, value, status, exch_order_no)
       VALUES ($1,$2,$3,$4,$5,$6,'desk',$7,$8,$9,$10,$11,'Live',$12)
       RETURNING *`,
      [makeRef('OFS'), b.issue_id, b.client_ucc, b.cp_code, b.custody_code, b.category,
       String(req.user.email || req.user.id), b.qty, b.price, b.is_cutoff, value, b.exch_order_no]);

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

    const b = {
      issue_id: before.issue_id,
      client_ucc: before.client_ucc,
      category: req.body.category || before.category,
      qty: Number(req.body.qty != null ? req.body.qty : before.qty) || 0,
      is_cutoff: req.body.is_cutoff != null ? !!req.body.is_cutoff : before.is_cutoff,
      price: null,
      editingId: before.id
    };
    b.price = b.is_cutoff ? null : Number(req.body.price != null ? req.body.price : before.price) || 0;

    const ctx = await loadContext(b.issue_id, b.client_ucc, before.id);
    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    const value = bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff);
    const r = await one(
      `UPDATE ${SCHEMA}.ofs_bid
          SET qty = $1, price = $2, is_cutoff = $3, value = $4, category = $5,
              status = 'Live', exch_order_no = COALESCE($6, exch_order_no)
        WHERE id = $7 RETURNING *`,
      [b.qty, b.price, b.is_cutoff, value, b.category, req.body.exch_order_no || null, before.id]);

    await audit.log(req, 'modify', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { next(e); }
});

/** DELETE /api/bids/:id - cancel (never a hard delete; the row is the audit trail). */
router.delete('/:id', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const before = await one(`SELECT * FROM ${SCHEMA}.ofs_bid WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found' });
    const r = await one(
      `UPDATE ${SCHEMA}.ofs_bid SET status = 'Cancelled', reject_reason = $2 WHERE id = $1 RETURNING *`,
      [before.id, req.body && req.body.reason ? String(req.body.reason).slice(0, 300) : null]);
    await audit.log(req, 'cancel', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { next(e); }
});

/** POST /api/bids/validate - dry-run for the UI, no write. */
router.post('/validate', requirePage(PAGE), async (req, res, next) => {
  try {
    const b = normalise(req.body || {});
    const ctx = await loadContext(b.issue_id, b.client_ucc, req.body.editingId || null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });
    if (req.body.editingId) b.editingId = req.body.editingId;
    const errs = validateBid(ctx.issue, b, ctx);
    res.json({
      ok: errs.length === 0,
      errors: errs,
      value: bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff),
      min_price: minPrice(ctx.issue, b.category),
      available_margin: ctx.availableMargin,
      free_margin: ctx.availableMargin - ctx.marginUsed
    });
  } catch (e) { next(e); }
});

module.exports = router;
