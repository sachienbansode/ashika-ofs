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

/**
 * A timestamp for people, in IST, as 'YYYY-MM-DD HH:MM:SS'.
 *
 * The app server runs UTC, so a bare toISOString() on a desk report reads five and a
 * half hours off and nobody notices until it matters. Never used in an exchange
 * file — those carry no timestamps at all.
 */
const IST_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
function istStamp(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return '';
  const p = {};
  for (const part of IST_FMT.formatToParts(d)) p[part.type] = part.value;
  const h = String(Number(p.hour) % 24).padStart(2, '0');   // en-GB gives '24' at midnight
  return p.year + '-' + p.month + '-' + p.day + ' ' + h + ':' + p.minute + ':' + p.second;
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
 * There is NO shared action code. The two exchanges disagree, and a shared helper
 * here is how one of them silently gets the other's:
 *
 *   BSE  N / M / D   Notice 20150122-30, Annexure 1: "'N' for new record, 'M' for
 *                    to be modified record and 'D' for to deletion records."
 *   NSE  E / M / C   OFS WEB API Protocol v1.3.0, operationType: "'E' - Place
 *                    Order, 'M' - Modify Order, 'C' - Cancel Order, 'CF' - Carry
 *                    forward."
 *
 * So each adapter owns its own. This function is deliberately left un-exported;
 * anything importing an action code from here was getting the wrong exchange's.
 */
function actionCodeFor(exchange, bid) {
  const cancelled = bid.status === 'Cancelled';
  const modified = bid.status === 'Modified';
  if (String(exchange).toUpperCase() === 'NSE') {
    return cancelled ? 'C' : modified ? 'M' : 'E';
  }
  return cancelled ? 'D' : modified ? 'M' : 'N';
}

module.exports = { csvEsc, toCsv, toPipe, sha256, stamp, istStamp, effectivePrice, actionCodeFor };
