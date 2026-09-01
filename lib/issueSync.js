'use strict';
/**
 * Write exchange-sourced issues into ofs_issue.
 *
 * Rule: the exchange owns the facts (floor price, windows, quantities), the desk
 * owns its own decisions. So a refresh updates exchange fields on an existing row
 * but never touches `status` — if the desk suspended an issue, a poll must not
 * quietly reopen it — and never overwrites a row the desk entered by hand unless
 * the values actually differ.
 */
const { SCHEMA, one, rows } = require('./../db/ofsAdapter');

const { changed, EXCHANGE_FIELDS } = require('./issueDiff');

async function upsertIssues(issues, actor) {
  let inserted = 0, updated = 0, skipped = 0;
  const detail = [];

  for (const i of issues) {
    // Matched the way the unique index does: symbol + ISIN + trading day.
    const existing = await one(
      `SELECT * FROM ${SCHEMA}.ofs_issue
        WHERE upper(btrim(symbol)) = upper(btrim($1))
          AND upper(btrim(isin))   = upper(btrim($2))
          AND issue_date = ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`,
      [i.symbol, i.isin, i.hni_open]);

    if (!existing) {
      const cols = ['symbol', 'company', 'isin', 'exchange', 'bse_scrip_code', 'floor_price',
        'cut_price_min', 'tick', 'lot', 'issue_qty', 'retail_qty', 'discount_pct',
        'hni_open', 'hni_close', 'ret_open', 'ret_close', 'source', 'created_by'];
      const vals = cols.map((c) => (c === 'created_by' ? actor : i[c] == null ? null : i[c]));
      await one(
        `INSERT INTO ${SCHEMA}.ofs_issue (${cols.join(',')})
         VALUES (${cols.map((_, n) => '$' + (n + 1)).join(',')}) RETURNING id`, vals);
      inserted++;
      detail.push({ symbol: i.symbol, action: 'inserted' });
      continue;
    }

    const diff = changed(existing, i);
    if (!diff.length) { skipped++; continue; }

    // status is deliberately absent: a desk suspension outlives a refresh.
    await one(
      `UPDATE ${SCHEMA}.ofs_issue
          SET ${diff.map((f, n) => f + ' = $' + (n + 2)).join(', ')}, source = 'exchange'
        WHERE id = $1 RETURNING id`,
      [existing.id].concat(diff.map((f) => i[f])));
    updated++;
    detail.push({ symbol: i.symbol, action: 'updated', fields: diff });
  }

  return { inserted, updated, skipped, detail };
}

module.exports = { upsertIssues, changed, EXCHANGE_FIELDS };
