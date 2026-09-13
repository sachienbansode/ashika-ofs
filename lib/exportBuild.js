'use strict';
/**
 * Building an exchange file.
 *
 * This is the ONLY place a bid file is assembled. The Exchange files screen calls
 * it, and so does the scheduled email — a second implementation that drifted by a
 * column, a rounding or a status filter would produce two different files for the
 * same bids, and the one nobody looked at is the one that gets uploaded.
 *
 * Lifted out of routes/export.js unchanged, for that reason and no other.
 */
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { adapterFor, isExchange } = require('./exchange');
const settings = require('./settings');

function exchangeClause(exchange, alias, params) {
  if (!isExchange(exchange)) return '';                 // the desk's own extract takes everything
  params.push(String(exchange).toUpperCase());
  const n = params.length;
  return ` AND (upper(${alias}.exchange) = $${n}
                OR (${alias}.exchange IS NULL AND upper(i.exchange) = $${n}))`;
}

async function collect(q, exchange) {
  const w = [], p = [];
  if (q.issue_id && q.issue_id !== 'all') { p.push(q.issue_id); w.push('b.issue_id = $' + p.length); }
  if (q.category && q.category !== 'all') { p.push(q.category); w.push('b.category = $' + p.length); }
  if (q.branch_code) {
    p.push(String(q.branch_code).trim().toUpperCase());
    w.push('upper(b.branch_code) = $' + p.length);
  }
  if (q.q) {
    p.push('%' + String(q.q).trim().toUpperCase() + '%');
    w.push('(upper(b.client_ucc) LIKE $' + p.length + ' OR upper(i.symbol) LIKE $' + p.length +
           ' OR upper(b.ref) LIKE $' + p.length + ')');
  }
  // The desk's own extract answers "the book as it stood on that day", so it takes
  // the same as-on filter the bid book does, compared in IST for the same reason.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.as_on || ''))) {
    p.push(String(q.as_on).slice(0, 10));
    w.push(`(b.created_at AT TIME ZONE 'Asia/Kolkata')::date = $${p.length}::date`);
  }
  if (q.status) { p.push(q.status); w.push('b.status = $' + p.length); }
  else if (String(q.include_cancelled || '') === '1') w.push("b.status IN ('Live','Modified','Cancelled')");
  else w.push("b.status IN ('Live','Modified')");

  const exchSql = exchangeClause(exchange, 'b', p);

  const r = await rows(
    `SELECT b.*, row_to_json(i) AS issue
       FROM ${SCHEMA}.ofs_bid b
       JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : 'WHERE true'}${exchSql}
      ORDER BY i.symbol, b.client_ucc, b.created_at`, p);
  return r;
}

/**
 * A file that reaches an exchange carries the ISIN as the instrument's identity. An
 * issue seeded from public reporting may not have a confirmed one yet (it is stored
 * as a placeholder rather than as a plausible-looking guess), so refuse to build the
 * file rather than send an exchange something that is not an ISIN.
 */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

function assertExportable(bids, exchange) {
  const bad = [];
  for (const b of bids) {
    const i = b.issue || {};
    if (!ISIN_RE.test(String(i.isin || '').toUpperCase())) {
      if (bad.indexOf(i.symbol) < 0) bad.push(i.symbol);
    }
  }

  /* BSE writes the FLOOR PRICE into a cut-off (RIC) row — "Please mention floor
     price when category is RIC" (Notice 20150122-30, Annexure 1). If the seller has
     not published a floor, that cell cannot be filled and the row would be rejected
     at the exchange. Refuse the file and say which bids, rather than upload
     something that comes back as an error report.
     NSE is unaffected: a cut-off there is a market order with a blank price. */
  if (String(exchange).toUpperCase() === 'BSE') {
    const noFloor = [];
    for (const b of bids) {
      const i = b.issue || {};
      if (b.is_cutoff && (i.floor_price == null || !(Number(i.floor_price) > 0))) {
        if (noFloor.indexOf(i.symbol) < 0) noFloor.push(i.symbol);
      }
    }
    if (noFloor.length) {
      const e = new Error('BSE requires the floor price on a cut-off (RIC) bid, and it is not '
        + 'published for: ' + noFloor.join(', ') + '. Enter the floor price under Masters → Issues '
        + 'once the exchange announces it, or export the price bids only.');
      e.status = 422;
      e.code = 'floor_unknown';
      e.symbols = noFloor;
      throw e;
    }
  }
  if (bad.length) {
    const e = new Error('These issues have no confirmed ISIN yet: ' + bad.join(', ') +
      '. Enter the ISIN from the exchange notice under Masters -> Issues before generating a bid file.');
    e.status = 422;
    e.code = 'isin_missing';
    e.symbols = bad;
    throw e;
  }
}

/**
 * Bids that belong to neither file. Only possible on a BOTH issue, and only for a
 * bid placed before the exchange had to be chosen. Dropping them quietly would mean
 * a client who bid is simply not submitted, and nothing on screen would say so.
 */
async function unroutedBids(q) {
  const p = [];
  const where = [];
  if (q.issue_id && q.issue_id !== 'all') { p.push(q.issue_id); where.push('b.issue_id = $' + p.length); }
  return rows(
    `SELECT b.id, b.ref, b.client_ucc, i.symbol
       FROM ${SCHEMA}.ofs_bid b
       JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
      WHERE b.status IN ('Live','Modified')
        AND b.exchange IS NULL
        AND upper(i.exchange) = 'BOTH'
        ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY i.symbol, b.client_ucc`, p);
}

/* buildFile, collect and the guards now live in lib/exportBuild — the scheduled
 * email has to produce byte-for-byte the same file this screen downloads, and the
 * only way to be sure of that is for both to call the same function. */
async function buildFile(exchange, q) {
  const s = await settings.all();
  const adapter = adapterFor(exchange);
  const bids = await collect(q, exchange);
  // The exchange guards — ISIN present, floor known for a BSE cut-off — exist so we
  // never send an exchange something it will reject. The desk's own extract goes to
  // nobody, and refusing it because an issue has no ISIN yet would withhold exactly
  // the rows someone is trying to look at.
  if (isExchange(exchange)) assertExportable(bids, exchange);
  let symbol = null;
  if (q.issue_id && q.issue_id !== 'all') {
    const i = await one(`SELECT symbol FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [q.issue_id]);
    symbol = i && i.symbol;
  }
  return adapter.build(bids, s, {
    symbol,
    memberCode: q.member_code,
    part: q.part,                      // BSE caps a file at 100 records
    pipe: String(q.pipe || '') === '1'
  });
}


module.exports = { buildFile, collect, exchangeClause, assertExportable, unroutedBids };
