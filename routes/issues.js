'use strict';
/** OFS issue master (the scrip master). Phase 1: manual / CSV ingestion. */
const express = require('express');
const { SCHEMA, rows, one, query } = require('../db/ofsAdapter');
const { requirePage, requireEdit } = require('../middleware/pageAccess');
const { issueStatus, catStatus } = require('../lib/domain');
const audit = require('../lib/audit');

const router = express.Router();
const PAGE = 'ofs-masters';

const COLS = `id, symbol, company, isin, series, exchange, bse_scrip_code,
  floor_price, cut_price_min, tick, lot, issue_qty, retail_qty, discount_pct, cutoff_flag,
  hni_open, hni_close, ret_open, ret_close, indicative_ri, indicative_ni,
  status, source, created_by, created_at, updated_at`;

function decorate(r) {
  return Object.assign({}, r, {
    status_label: issueStatus(r),
    hni_status: catStatus(r, 'HNI'),
    ret_status: catStatus(r, 'Retail')
  });
}

router.get('/', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const open = String(req.query.open || '') === '1';
    const r = await rows(
      `SELECT ${COLS} FROM ${SCHEMA}.ofs_issue
        ${open ? "WHERE status <> 'Closed' AND greatest(hni_close, ret_close) > now() - interval '1 day'" : ''}
        ORDER BY greatest(hni_close, ret_close) DESC, symbol`
    );
    res.json({ issues: r.map(decorate) });
  } catch (e) { next(e); }
});

router.get('/:id', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const r = await one(`SELECT ${COLS} FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json({ issue: decorate(r) });
  } catch (e) { next(e); }
});

const FIELDS = ['symbol','company','isin','series','exchange','bse_scrip_code','floor_price','cut_price_min',
  'tick','lot','issue_qty','retail_qty','discount_pct','cutoff_flag','hni_open','hni_close','ret_open','ret_close',
  'indicative_ri','indicative_ni','status'];

function pick(body) {
  const out = {};
  for (const f of FIELDS) if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  return out;
}

router.post('/', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const v = pick(req.body || {});
    for (const req_f of ['symbol','company','isin','floor_price','hni_open','hni_close','ret_open','ret_close']) {
      if (!v[req_f]) return res.status(400).json({ error: 'missing_field', field: req_f });
    }
    if (v.cut_price_min == null) v.cut_price_min = v.floor_price;
    const keys = Object.keys(v);
    const r = await one(
      `INSERT INTO ${SCHEMA}.ofs_issue (${keys.join(',')}, created_by)
       VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}, $${keys.length + 1})
       RETURNING ${COLS}`,
      keys.map((k) => v[k]).concat([req.user.email || String(req.user.id)])
    );
    await audit.log(req, 'create', 'ofs_issue', r.id, null, r);
    res.status(201).json({ issue: decorate(r) });
  } catch (e) { next(e); }
});

router.put('/:id', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const before = await one(`SELECT ${COLS} FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found' });
    const v = pick(req.body || {});
    const keys = Object.keys(v);
    if (!keys.length) return res.json({ issue: decorate(before) });
    const r = await one(
      `UPDATE ${SCHEMA}.ofs_issue SET ${keys.map((k, i) => k + ' = $' + (i + 1)).join(', ')}
        WHERE id = $${keys.length + 1} RETURNING ${COLS}`,
      keys.map((k) => v[k]).concat([req.params.id])
    );
    await audit.log(req, 'update', 'ofs_issue', r.id, before, r);
    res.json({ issue: decorate(r) });
  } catch (e) { next(e); }
});

router.delete('/:id', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const before = await one(`SELECT ${COLS} FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found' });
    const used = await one(`SELECT count(*)::int AS n FROM ${SCHEMA}.ofs_bid WHERE issue_id = $1`, [req.params.id]);
    if (used.n > 0) return res.status(409).json({ error: 'has_bids', bids: used.n });
    await query(`DELETE FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [req.params.id]);
    await audit.log(req, 'delete', 'ofs_issue', req.params.id, before, null);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
