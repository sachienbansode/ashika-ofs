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
function effectivePrice(bid, issue, settings) {
  if (!bid.is_cutoff) return Math.round(Number(bid.price) * 100) / 100;
  return String(settings.cutoff_price_mode) === 'floor'
    ? Math.round(Number(issue.floor_price) * 100) / 100
    : 0;
}

/** N = new, M = modify, C = cancel. */
function actionCode(bid) {
  if (bid.status === 'Cancelled') return 'C';
  if (bid.status === 'Modified') return 'M';
  return 'N';
}

module.exports = { csvEsc, toCsv, toPipe, sha256, stamp, effectivePrice, actionCode };
