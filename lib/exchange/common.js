'use strict';
const crypto = require('crypto');

function csvEsc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** CRLF line endings - both exchanges' bulk-upload parsers expect DOS text. */
function toCsv(rows) { return rows.map((r) => r.map(csvEsc).join(',')).join('\r\n') + '\r\n'; }
function toPipe(rows) { return rows.map((r) => r.map((v) => String(v == null ? '' : v)).join('|')).join('\r\n') + '\r\n'; }

function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }

function stamp(d) {
  d = d || new Date();
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
}

/** Price written to the exchange for a cut-off bid: 0 or the floor, per setting. */
/**
 * The price to put in the file.
 *
 * A cut-off bid carries the FLOOR PRICE, not zero. BSE Notice 20150122-30 is
 * explicit twice over: Annexure 1 says "Please mention floor price when category is
 * RIC", and 4.3.5 says "Margin for bids placed at cut-off price shall be at the
 * floor price". A zero would fail the exchange's own "price must be at or above the
 * floor" check, so every retail cut-off bid in the file would have been rejected.
 *
 * cutoff_price_mode is kept as an escape hatch, but 'floor' is now the default and
 * 'zero' should only be set if an exchange ever asks for it in writing.
 */
function effectivePrice(bid, issue, settings) {
  if (!bid.is_cutoff) return Math.round(Number(bid.price) * 100) / 100;
  return String((settings && settings.cutoff_price_mode) || 'floor') === 'zero'
    ? 0
    : Math.round(Number(issue.floor_price) * 100) / 100;
}

/**
 * N = new, M = modify, D = delete.
 *
 * 'D', not 'C'. BSE Notice 20150122-30, Annexure 1: "Action code, i.e., 'N' for new
 * record, 'M' for to be modified record and 'D' for to deletion records." The
 * prototype had C, which would have had every cancellation rejected.
 */
function actionCode(bid) {
  if (bid.status === 'Cancelled') return 'D';
  if (bid.status === 'Modified') return 'M';
  return 'N';
}

module.exports = { csvEsc, toCsv, toPipe, sha256, stamp, effectivePrice, actionCode };
