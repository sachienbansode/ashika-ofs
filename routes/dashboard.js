'use strict';
/** Real-time desk dashboard aggregates. Polled by the UI; cheap enough for 5s refresh. */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { requirePage } = require('../middleware/pageAccess');
const { issueStatus, catStatus, minPrice, openOnDay, issueOpenOnDay } = require('../lib/domain');
const settings = require('../lib/settings');

const router = express.Router();
const PAGE = 'ofs-desk';

/**
 * Which day's book is this?
 *
 * The dashboard is a DAILY view: an OFS is a one- or two-day event, the desk starts
 * each morning with a fresh book, and the figures on this screen are read as "what
 * has come in today". So the default is today, not "every live bid ever".
 *
 * This was the bug: the recent list defaulted to today while the totals and the
 * per-issue aggregates counted every live bid, so the screen showed 6 live bids
 * worth ₹6.38 L above a panel that said "No bids yet". Both were describing real
 * numbers; neither said which day it meant. The same clause now reaches all three,
 * because three figures on one screen that disagree about their own scope is worse
 * than any one of them being wrong.
 *
 * `scope=all` opts out, and the desk needs it: the exchange file carries every LIVE
 * bid on an issue, including one placed yesterday on the T-day leg, so "all live" is
 * the view that matches what will actually be uploaded.
 *
 * Compared in Asia/Kolkata. The server runs UTC, where today starts at 05:30 IST and
 * a bid placed at 09:20 IST would otherwise belong to the previous day.
 */
function scopeOf(req) {
  const q = req.query || {};
  if (String(q.scope || '') === 'all') return { date: null, all: true };
  const d = String(q.as_on || '').slice(0, 10);
  return { date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : 'today', all: false };
}

function asOnClause(scope, alias, params) {
  if (scope.all) return '';
  if (scope.date === 'today') {
    return ` AND (${alias}.created_at AT TIME ZONE 'Asia/Kolkata')::date`
         + ` = (now() AT TIME ZONE 'Asia/Kolkata')::date`;
  }
  params.push(scope.date);
  return ` AND (${alias}.created_at AT TIME ZONE 'Asia/Kolkata')::date = $${params.length}::date`;
}

router.get('/', requirePage(PAGE), async (req, res, next) => {
  try {
    const s = await settings.all();
    const scope = scopeOf(req);
    const aggP = [];
    const aggSql = asOnClause(scope, 'ofs_bid', aggP);

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
            WHERE status = 'Live'${aggSql}
            GROUP BY issue_id
         ) b ON b.issue_id = i.id
        WHERE i.archived_at IS NULL
          AND i.status <> 'Closed'
          AND greatest(i.hni_close, i.ret_close) > now() - interval '2 days'
        ORDER BY greatest(i.hni_close, i.ret_close) ASC`, aggP);

    const now = new Date();
    /*
     * When the screen is showing a PAST date, "open" has to mean open on that date.
     * catStatus answers "right now", which is the wrong question: an issue whose
     * window ran 09:15–15:15 on the 11th is Closed now and was open all day then, so
     * a screen headed "11-Sep" was reporting 0 open issues above three bids placed
     * on it.
     *
     * Today and "all live" keep the live answer, because on those views the question
     * really is "what can be bid on now".
     */
    const onDay = scope.all || scope.date === 'today' ? null : scope.date;
    const list = issues.map((i) => {
      const issueQty = Number(i.issue_qty) || 0;
      const retQty = Number(i.retail_qty) || 0;
      const nonRetQty = issueQty && retQty ? issueQty - retQty : 0;
      return Object.assign({}, i, {
        status_label: issueStatus(i, now),
        hni_status: catStatus(i, 'HNI', now),
        ret_status: catStatus(i, 'Retail', now),
        // Open ON THE DAY being shown. Separate from the three above on purpose:
        // those drive what can be bid right now, this drives what is counted and
        // listed for the date on screen, and conflating them is what caused the
        // "0 open issues" over three bids.
        open_on_scope: onDay ? issueOpenOnDay(i, onDay) : null,
        ret_open_on_scope: onDay ? openOnDay(i, 'Retail', onDay) : null,
        hni_open_on_scope: onDay ? openOnDay(i, 'HNI', onDay) : null,
        min_price_retail: minPrice(i, 'Retail'),
        min_price_hni: minPrice(i, 'HNI'),
        subscription_x: issueQty ? Number(i.total_qty) / issueQty : null,
        ret_subscription_x: retQty ? Number(i.ret_qty) / retQty : null,
        hni_subscription_x: nonRetQty ? Number(i.hni_qty) / nonRetQty : null,
        our_vwap: i.vwap == null ? null : Number(i.vwap)
      });
    });

    const totP = [];
    const totSql = asOnClause(scope, 'ofs_bid', totP);
    const totals = await one(
      `SELECT count(*)::int AS bids, COALESCE(sum(qty),0)::bigint AS qty,
              COALESCE(sum(value),0) AS value, count(DISTINCT client_ucc)::int AS clients
         FROM ${SCHEMA}.ofs_bid WHERE status = 'Live'${totSql}`, totP);

    // What the exchange file would actually carry, whatever day is on screen. A desk
    // looking at today's book still has to know the whole live book exists, or it
    // generates a file it did not expect.
    const allLive = await one(
      `SELECT count(*)::int AS bids, COALESCE(sum(value),0) AS value
         FROM ${SCHEMA}.ofs_bid WHERE status = 'Live'`);

    const recP = [];
    const recSql = asOnClause(scope, 'b', recP);
    const recent = await rows(
      `SELECT b.id, b.ref, b.client_ucc, b.branch_code, b.placed_by, b.category, b.qty, b.price,
              b.is_cutoff, b.value, b.status, b.created_at, i.symbol
         FROM ${SCHEMA}.ofs_bid b
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
        WHERE true${recSql}
        ORDER BY b.created_at DESC LIMIT 15`, recP);

    res.json({
      server_time: now.toISOString(),
      // 'today' | a date | null when the whole live book is being shown. Every
      // figure below is on this one scope — that is the point.
      scope: scope.all ? 'all' : scope.date,
      as_on: scope.all || scope.date === 'today' ? null : scope.date,
      all_live: { bids: (allLive && allLive.bids) || 0, value: Number((allLive && allLive.value) || 0) },
      settings: s, issues: list, totals, recent
    });
  } catch (e) { next(e); }
});

module.exports = router;
