'use strict';
/**
 * What a signed-in client can see and do. Every route is scoped to req.client.ucc:
 * a client can only ever read or write their own bids, never another account's.
 */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { requireClient } = require('../middleware/clientAuth');
const { issueStatus, catStatus, minPrice } = require('../lib/domain');
const settings = require('../lib/settings');
const ld = require('../db/ldAdapter');

const router = express.Router();
router.use(requireClient);

/** Open issues, as a client sees them: no desk aggregates, no other clients' bids. */
router.get('/issues', async (req, res, next) => {
  try {
    const s = await settings.all();
    const list = await rows(
      `SELECT id, symbol, company, isin, exchange, floor_price, cut_price_min, tick, lot,
              discount_pct, cutoff_flag, hni_open, hni_close, ret_open, ret_close,
              indicative_ri, indicative_ni, status
         FROM ${SCHEMA}.ofs_issue
        WHERE archived_at IS NULL
          AND status <> 'Closed' AND greatest(hni_close, ret_close) > now()
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

module.exports = router;
