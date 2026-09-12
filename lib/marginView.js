'use strict';
/**
 * Client-wise margin, read the same way for all three logins.
 *
 * A client sees their own; a branch or Authorised Partner sees their clients'; the
 * desk sees everyone's. That is one question asked over three different sets of
 * UCCs, so it is one function here and the CALLER decides the set — which is also
 * the access control: nothing in this file knows who is asking, and nothing in it
 * can widen a scope the caller already narrowed.
 *
 * Three figures, and the difference between them matters:
 *
 *   available  what the desk (or the RMS upload) says the client has today.
 *   used       the value of their LIVE bids. Cancelled and rejected bids release
 *              their hold, so they are not counted; a cut-off bid is held at the
 *              floor, which is what lib/domain values it at and what the exchange
 *              blocks.
 *   free       available - used. It can go NEGATIVE, and when it does that is a
 *              fact worth showing rather than clamping to zero: it means margin was
 *              reduced after bids were already live, and somebody has to decide
 *              which bid gives way before the file goes to the exchange.
 *
 * Margins are cleared to zero at the start of each day and re-uploaded, so an
 * `at` of yesterday against a non-zero available is itself a warning sign.
 */
const { SCHEMA, rows } = require('../db/ofsAdapter');

const num = (v) => Number(v) || 0;

/**
 * Margin for a set of UCCs, as a Map keyed by UCC.
 *
 * FULL JOIN, not LEFT: a client can have live bids and no margin row (the reset
 * deletes rows, or nobody uploaded one), and that client is precisely the one a
 * desk needs to see. A LEFT JOIN from ofs_margin would drop them.
 */
async function forUccs(uccs) {
  const list = Array.from(new Set((uccs || [])
    .map((u) => String(u || '').trim().toUpperCase()).filter(Boolean)));
  const out = new Map();
  if (!list.length) return out;

  const r = await rows(
    `SELECT COALESCE(m.client_ucc, u.client_ucc) AS client_ucc,
            COALESCE(m.available, 0)            AS available,
            m.updated_at                        AS margin_at,
            m.source                            AS margin_source,
            COALESCE(u.used, 0)                 AS used,
            COALESCE(u.bids, 0)                 AS live_bids
       FROM ${SCHEMA}.ofs_margin m
       FULL JOIN (SELECT client_ucc, sum(value) AS used, count(*)::int AS bids
                    FROM ${SCHEMA}.ofs_bid WHERE status = 'Live' GROUP BY client_ucc) u
         ON u.client_ucc = m.client_ucc
      WHERE COALESCE(m.client_ucc, u.client_ucc) = ANY($1)`, [list]);

  for (const row of r) {
    const available = num(row.available), used = num(row.used);
    out.set(row.client_ucc, {
      ucc: row.client_ucc,
      available_margin: available,
      margin_used: used,
      free_margin: available - used,
      margin_at: row.margin_at || null,
      margin_source: row.margin_source || null,
      live_bids: num(row.live_bids)
    });
  }
  return out;
}

/** The zero row, so a client with no margin record still renders as a row of zeroes. */
function empty(ucc) {
  return { ucc: String(ucc || '').trim().toUpperCase(), available_margin: 0, margin_used: 0,
           free_margin: 0, margin_at: null, margin_source: null, live_bids: 0 };
}

/** Attach margin to rows that carry a UCC, in one round trip. */
async function attach(list, uccField) {
  const f = uccField || 'ucc';
  const map = await forUccs((list || []).map((r) => r && r[f]));
  return (list || []).map((r) => {
    const m = map.get(String((r && r[f]) || '').trim().toUpperCase()) || empty(r && r[f]);
    return Object.assign({}, r, {
      available_margin: m.available_margin, margin_used: m.margin_used,
      free_margin: m.free_margin, margin_at: m.margin_at, live_bids: m.live_bids
    });
  });
}

/**
 * The totals across a set of UCCs.
 *
 * `short` is the count of clients whose free margin is below zero — the number a
 * desk or an AP actually acts on, and the one a column of figures hides.
 */
function totalsOf(list) {
  const t = { clients: 0, available: 0, used: 0, free: 0, short: 0, with_bids: 0 };
  for (const r of list || []) {
    t.clients++;
    t.available += num(r.available_margin);
    t.used += num(r.margin_used);
    t.free += num(r.free_margin);
    if (num(r.free_margin) < 0) t.short++;
    if (num(r.live_bids) > 0) t.with_bids++;
  }
  return t;
}

/** Totals over a scope, without paging it into memory row by row. */
async function totalsFor(uccs) {
  const map = await forUccs(uccs);
  const seen = Array.from(new Set((uccs || [])
    .map((u) => String(u || '').trim().toUpperCase()).filter(Boolean)));
  return totalsOf(seen.map((u) => map.get(u) || empty(u)));
}

module.exports = { forUccs, attach, empty, totalsOf, totalsFor };
