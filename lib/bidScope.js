'use strict';
/**
 * What counts as a bid that is STILL WORKING.
 *
 * ofs_bid.status records what the CLIENT did with a bid — placed it, modified it,
 * withdrew it. Nothing in it records what the OFFER did, and an offer closing is
 * not an event anybody types: at the cut-off the bid simply stops being something
 * that can be changed and goes to the exchange in the file.
 *
 * So every bid sat at 'Live' for ever. Offers that finished last week went on
 * holding margin the client had long since got back, every screen went on calling
 * those bids LIVE, and a client whose margin was consumed by a closed offer could
 * not place today's bid at all.
 *
 * A bid is WORKING when the client has not withdrawn it and the offer it is on is
 * still taking bids — its own category's window, closed at the desk cut-off, is
 * what decides, exactly as lib/domain.js catStatus decides it for a screen.
 *
 * That rule is written twice here, once for JS and once for SQL, because the
 * margin total is a GROUP BY over every bid and cannot be computed row by row in
 * Node. Twice and nowhere else: the last time one rule had two owners, the issue
 * panel printed the offer's own close while the refusal printed the cut-off, and
 * the desk had no way to tell which was true.
 */
const { catStatus, SESSION_CLOSE } = require('./domain');

/** The desk cut-off, in the 'HH:MM' shape both sides of this file expect. */
function cutoffOf(settings) {
  const t = settings && settings.daily_cutoff;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || '')) ? String(t) : SESSION_CLOSE;
}

/**
 * domain.js atIstTime(), in SQL: the IST calendar day `col` falls on, at the desk
 * cut-off, back as a timestamptz. The server runs UTC, so every step of this has
 * to name the zone — `col::date` alone would be the UTC date, which is yesterday's
 * for anything before 05:30 IST.
 */
const effClose = (col, at) =>
  `(((( ${col} ) AT TIME ZONE 'Asia/Kolkata')::date + $${at}::time) AT TIME ZONE 'Asia/Kolkata')`;

/**
 * The SQL predicate. `at` is the 1-based parameter position holding the cut-off;
 * the caller pushes cutoffOf(settings) at that position. `b` and `i` are the bid
 * and issue table aliases — the issue MUST be joined, because without it there is
 * no window to test and the answer silently falls back to the old wrong one.
 */
function workingSql(at, b, i) {
  b = b || 'b'; i = i || 'i';
  return `${b}.status = 'Live'
      AND ${i}.status NOT IN ('Closed', 'Withdrawn')
      AND now() <= ${effClose(
        `CASE WHEN ${b}.category = 'HNI' THEN ${i}.hni_close ELSE ${i}.ret_close END`, at)}`;
}

/**
 * The same question for one row that already has its issue beside it.
 * `issue` may be the issue record or a bid row carrying ret_close/hni_close.
 */
function isWorking(bid, issue, now, settings) {
  if (!bid || String(bid.status) !== 'Live') return false;
  if (!issue) return false;
  return catStatus(issue, bid.category === 'HNI' ? 'HNI' : 'Retail', now, settings) === 'Open';
}

/**
 * What the status chip should say. The stored status is kept for every state the
 * client put the bid in; only 'Live' can be overtaken by the offer closing, and
 * when it is, "Live" is the one word the row must not use.
 */
function statusLabel(bid, issue, now, settings) {
  const s = String((bid && bid.status) || '');
  if (s !== 'Live') return s;
  return isWorking(bid, issue, now, settings) ? 'Live' : 'Closed';
}

/**
 * The issue, out of a bid row that was selected with its issue beside it.
 *
 * A joined row carries b.status AND i.status under one name unless the select
 * renames one, so catStatus would read the BID's status as the OFFER's and call a
 * cancelled bid's offer closed. The issue columns are pulled out explicitly here,
 * and the select must alias the issue's status to issue_status for this to work.
 */
function issueOf(row) {
  if (!row) return null;
  return {
    status: row.issue_status || 'Auto',
    ret_open: row.ret_open, ret_close: row.ret_close,
    hni_open: row.hni_open, hni_close: row.hni_close
  };
}

/** Stamp a list of joined bid rows with what the screen should say about each. */
function decorate(list, now, settings) {
  for (const row of list || []) {
    const i = issueOf(row);
    row.working = isWorking(row, i, now, settings);
    row.status_label = statusLabel(row, i, now, settings);
  }
  return list;
}

module.exports = { cutoffOf, effClose, workingSql, isWorking, statusLabel, issueOf, decorate };
