'use strict';
/** Real-time desk dashboard aggregates. Polled by the UI; cheap enough for 5s refresh. */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { requirePage } = require('../middleware/pageAccess');
const { issueStatus, catStatus, minPrice } = require('../lib/domain');
const settings = require('../lib/settings');

const router = express.Router();
const PAGE = 'ofs-desk';

router.get('/', requirePage(PAGE), async (req, res, next) => {
  try {
    const s = await settings.all();

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
            WHERE status = 'Live'
            GROUP BY issue_id
         ) b ON b.issue_id = i.id
        WHERE i.status <> 'Closed'
          AND greatest(i.hni_close, i.ret_close) > now() - interval '2 days'
        ORDER BY greatest(i.hni_close, i.ret_close) ASC`);

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

    const totals = await one(
      `SELECT count(*)::int AS bids, COALESCE(sum(qty),0)::bigint AS qty,
              COALESCE(sum(value),0) AS value, count(DISTINCT client_ucc)::int AS clients
         FROM ${SCHEMA}.ofs_bid WHERE status = 'Live'`);

    const recent = await rows(
      `SELECT b.id, b.ref, b.client_ucc, b.category, b.qty, b.price, b.is_cutoff, b.value,
              b.status, b.created_at, i.symbol
         FROM ${SCHEMA}.ofs_bid b
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
        ORDER BY b.created_at DESC LIMIT 15`);

    res.json({ server_time: now.toISOString(), settings: s, issues: list, totals, recent });
  } catch (e) { next(e); }
});

module.exports = router;
