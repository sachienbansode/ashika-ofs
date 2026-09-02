'use strict';
/**
 * Reading what BSE sends BACK, from iBBS → OFS → Downloads.
 *
 * Layouts from BSE Notice **20150122-30 (22 Jan 2015)**, Annexure 1, supplied by
 * Ashika on 2 Sep 2026. All are comma or pipe separated, with NO header row — the
 * same convention as the upload file.
 *
 * Why this matters more than it looks: **Bid Id**. The exchange generates it, and
 * Annexure 1 is explicit — "For modification/deletion the Bid value has to be
 * populated by Bid Id". Until the success file is imported we do not know it, so a
 * modify or cancel row would go up carrying 0 and be rejected. Uploading a file is
 * therefore only half the round trip; this is the other half.
 *
 * Four shapes, distinguished by column count and content rather than by filename,
 * because members rename downloads:
 *
 *   success     10 cols  symbol,cat,cp,ucc,custody,qty,price,margin,bidId,action
 *   rejection   11 cols  ...same 10..., errorText
 *   bid book    12 cols  symbol,cat,cp,ucc,custody,qty,price,bidId,entry,modified,margin,action
 *   allocation  11 cols  symbol,cat,cp,ucc,custody,qty,price,bidId,allotQty,allotPrice,margin
 *
 * Rejection and allocation are both 11 columns, so they are told apart by what sits
 * in the last field: an allocation ends in a margin flag (1 or 2), a rejection ends
 * in free text.
 */

const KINDS = ['success', 'rejection', 'bidbook', 'allocation'];

/** Split on comma or pipe — whichever the member chose when downloading. */
function splitLine(line) {
  const sep = line.indexOf('|') >= 0 && line.indexOf('|') < line.indexOf(',') ? '|'
    : (line.indexOf(',') >= 0 ? ',' : '|');
  return line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}

function rowsOf(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(splitLine);
}

const num = (v) => {
  const s = String(v == null ? '' : v).replace(/[, ]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};
const isMarginFlag = (v) => v === '1' || v === '2';
const isAction = (v) => ['N', 'M', 'D'].indexOf(String(v || '').toUpperCase()) >= 0;

/**
 * Work out which download this is. Returns null when nothing fits — better to
 * refuse than to read an allocation as a rejection and mark good bids failed.
 */
function detect(rows) {
  if (!rows.length) return null;
  const widths = {};
  for (const r of rows) widths[r.length] = (widths[r.length] || 0) + 1;
  const width = Number(Object.keys(widths).sort((a, b) => widths[b] - widths[a])[0]);
  const sample = rows.find((r) => r.length === width) || rows[0];

  if (width === 10 && isAction(sample[9])) return 'success';
  if (width === 12 && isAction(sample[11])) return 'bidbook';
  if (width === 11) {
    // The tie-break: allocation ends in a margin flag, rejection in error text.
    if (isMarginFlag(sample[10]) && num(sample[8]) != null) return 'allocation';
    return 'rejection';
  }
  return null;
}

function parseSuccess(r) {
  return { symbol: r[0], category: r[1], cp_code: r[2] || null, client_ucc: (r[3] || '').toUpperCase(),
           custody_code: r[4] || null, qty: num(r[5]), price: num(r[6]),
           margin: num(r[7]), bid_id: (r[8] || '').trim(), action: (r[9] || '').toUpperCase() };
}

function parseRejection(r) {
  return Object.assign(parseSuccess(r), { error: (r[10] || '').trim() });
}

function parseBidBook(r) {
  return { symbol: r[0], category: r[1], cp_code: r[2] || null, client_ucc: (r[3] || '').toUpperCase(),
           custody_code: r[4] || null, qty: num(r[5]), price: num(r[6]),
           bid_id: (r[7] || '').trim(), entered_at: r[8] || null, modified_at: r[9] || null,
           margin: num(r[10]), action: (r[11] || '').toUpperCase() };
}

function parseAllocation(r) {
  return { symbol: r[0], category: r[1], cp_code: r[2] || null, client_ucc: (r[3] || '').toUpperCase(),
           custody_code: r[4] || null, qty: num(r[5]), price: num(r[6]),
           bid_id: (r[7] || '').trim(), allot_qty: num(r[8]) || 0,
           allot_price: num(r[9]), margin: num(r[10]) };
}

const PARSERS = { success: parseSuccess, rejection: parseRejection,
                  bidbook: parseBidBook, allocation: parseAllocation };

/**
 * Parse a downloaded response file.
 * Returns { kind, rows, skipped, totals } — never throws on a bad line; a line that
 * does not fit the detected shape is reported, not guessed at.
 */
function parse(text, forceKind) {
  const raw = rowsOf(text);
  const kind = forceKind && KINDS.indexOf(forceKind) >= 0 ? forceKind : detect(raw);
  if (!kind) {
    return { kind: null, rows: [], skipped: raw.length,
             error: 'This does not match any BSE OFS download layout (expected 10, 11 or 12 columns).' };
  }

  const want = { success: 10, rejection: 11, bidbook: 12, allocation: 11 }[kind];
  const out = [], skipped = [];
  for (const r of raw) {
    if (r.length !== want || !r[0] || !r[3]) { skipped.push(r.join(',').slice(0, 120)); continue; }
    out.push(PARSERS[kind](r));
  }

  const totals = {
    rows: out.length,
    clients: new Set(out.map((x) => x.client_ucc)).size,
    qty: out.reduce((t, x) => t + (x.qty || 0), 0)
  };
  if (kind === 'allocation') {
    totals.allot_qty = out.reduce((t, x) => t + (x.allot_qty || 0), 0);
    totals.allottees = out.filter((x) => x.allot_qty > 0).length;
    totals.allot_value = out.reduce((t, x) => t + (x.allot_qty || 0) * (x.allot_price || 0), 0);
  }
  if (kind === 'rejection') totals.errors = out.filter((x) => x.error).length;

  return { kind, rows: out, skipped: skipped.length, skippedSample: skipped.slice(0, 5), totals };
}

module.exports = { parse, detect, splitLine, KINDS };
