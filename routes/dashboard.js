'use strict';
/** Real-time desk dashboard aggregates. Polled by the UI; cheap enough for 5s refresh. */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { requirePage } = require('../middleware/pageAccess');
const { issueStatus, catStatus, minPrice } = require('../lib/domain');
const settings = require('../lib/settings');

const router = express.Router();
const PAGE = 'ofs-desk';

/**
 * As-on date. Everything on the dashboard is "the book as it stood on this trading
 * day", not "the book now" — so the SAME date filter has to reach the aggregate,
 * the totals and the recent list, or the three disagree and the desk trusts none.
 *
 * Compared in Asia/Kolkata: the server runs UTC, where "today" starts at 05:30 IST
 * and a bid placed at 09:20 IST belongs to the previous day.
 */
function asOnClause(req, alias, params) {
  const d = String((req.query && req.query.as_on) || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { sql: '', date: null };
  params.push(d);
  return {
    sql: ` AND (${alias}.created_at AT TIME ZONE 'Asia/Kolkata')::date = $${params.length}::date`,
    date: d
  };
}

router.get('/', requirePage(PAGE), async (req, res, next) => {
  try {
    const s = await settings.all();
    const aggP = [];
    const agg = asOnClause(req, 'ofs_bid', aggP);

    const issues = await rows(
      `SELECT i.*,
              COALESCE(b.bid_count,0)     AS bid_count,
              COALESCE(b.total_qty,0)     AS total_qty,
              COALESCE(b.total_value,0)   AS total_value,
              COALESCE(b.ret_qty,0)       AS ret_qty,
              COALESCE(b.ret_value,0)     AS ret_value,
              COALESCE(b.hni_qty,0)       AS hni_qty,
              COALESCE(b.hni_value,0)     AS hni_value,
              COALESCE(b.client_count,0)  AS client_count,
              b.vwap
         FROM ${SCHEMA}.ofs_issue i
         LEFT JOIN (
           SELECT issue_id,
                  count(*)                                              AS bid_count,
                  count(DISTINCT client_ucc)                            AS client_count,
                  sum(qty)                                              AS total_qty,
                  sum(value)                                            AS total_value,
                  sum(qty) FILTER (WHERE category = 'Retail')           AS ret_qty,
                  sum(value) FILTER (WHERE category = 'Retail')         AS ret_value,
                  sum(qty) FILTER (WHERE category = 'HNI')              AS hni_qty,
                  sum(value) FILTER (WHERE category = 'HNI')            AS hni_value,
                  CASE WHEN sum(qty) FILTER (WHERE NOT is_cutoff) > 0
                       THEN sum(qty * price) FILTER (WHERE NOT is_cutoff)
                            / sum(qty) FILTER (WHERE NOT is_cutoff) END AS vwap
             FROM ${SCHEMA}.ofs_bid
            WHERE status = 'Live'${agg.sql}
            GROUP BY issue_id
         ) b ON b.issue_id = i.id
        WHERE i.archived_at IS NULL
          AND i.status <> 'Closed'
          AND greatest(i.hni_close, i.ret_close) > now() - interval '2 days'
        ORDER BY greatest(i.hni_close, i.ret_close) ASC`, aggP);

    const now = new Date();
    const list = issues.map((i) => {
      const issueQty = Number(i.issue_qty) || 0;
      const retQty = Number(i.retail_qty) || 0;
      const nonRetQty = issueQty && retQty ? issueQty - retQty : 0;
      return Object.assign({}, i, {
        status_label: issueStatus(i, now),
        hni_status: catStatus(i, 'HNI', now),
        ret_status: catStatus(i, 'Retail', now),
        min_price_retail: minPrice(i, 'Retail'),
        min_price_hni: minPrice(i, 'HNI'),
        subscription_x: issueQty ? Number(i.total_qty) / issueQty : null,
        ret_subscription_x: retQty ? Number(i.ret_qty) / retQty : null,
        hni_subscription_x: nonRetQty ? Number(i.hni_qty) / nonRetQty : null,
        our_vwap: i.vwap == null ? null : Number(i.vwap)
      });
    });

    const totP = [];
    const tot = asOnClause(req, 'ofs_bid', totP);
    const totals = await one(
      `SELECT count(*)::int AS bids, COALESCE(sum(qty),0)::bigint AS qty,
              COALESCE(sum(value),0) AS value, count(DISTINCT client_ucc)::int AS clients
         FROM ${SCHEMA}.ofs_bid WHERE status = 'Live'${tot.sql}`, totP);

    const recP = [];
    const rec = asOnClause(req, 'b', recP);
    // Default is TODAY, not "the last 15 whenever they were". A desk opening the
    // screen at 09:20 should see an empty list, not yesterday's book looking live.
    const todayOnly = rec.date
      ? rec.sql
      : ` AND (b.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`;
    const recent = await rows(
      `SELECT b.id, b.ref, b.client_ucc, b.branch_code, b.placed_by, b.category, b.qty, b.price,
              b.is_cutoff, b.value, b.status, b.created_at, i.symbol
         FROM ${SCHEMA}.ofs_bid b
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
        WHERE true${todayOnly}
        ORDER BY b.created_at DESC LIMIT 15`, recP);

    res.json({
      server_time: now.toISOString(),
      as_on: agg.date,                      // null means "now"
      recent_scope: rec.date || 'today',
      settings: s, issues: list, totals, recent
    });
  } catch (e) { next(e); }
});

module.exports = router;
