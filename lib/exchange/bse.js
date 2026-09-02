'use strict';
/**
 * BSE iBBS OFS bulk-bid file.
 *
 * Layout taken from BSE's own "Comprehensive Amended Guidelines — OFS Segment"
 * (bseindia.com/downloads1/BSEComprehensiveAmendedGuidelines_OFS_Segment.pdf),
 * verified 2026-09-01. Ten fields, in this order, with NO header row:
 *
 *   1 OFS Symbol              alphanumeric(10)  mandatory
 *   2 Category                alphanumeric(5)   mandatory  MF|IC|OTHS|NII|RI|RIC
 *   3 Client/CP code          alphanumeric(16)  optional, institutional give-ups
 *   4 UCC                     alphanumeric(12)  mandatory
 *   5 Custodian clearing code alphanumeric(12)  optional
 *   6 Qty                     numeric(11)       mandatory, multiple of market lot
 *   7 Price                   numeric(6,2)      mandatory, at or above floor
 *   8 Margin                  numeric(1)        1 = 0% margin, 2 = 100% upfront
 *   9 Bid Id                  numeric(16)       0 for a new record; the exchange id for M/D
 *  10 Action Code             alphanumeric(1)   N = new, M = modify, D = delete
 *
 * Confirmed against BSE Notice **20150122-30, 22 Jan 2015** — "Comprehensive
 * Modified Guidelines for Bidding in OFS Segment", Annexure 1 — supplied by Ashika
 * on 2 Sep 2026. Four things it settles that we had wrong or missing:
 *   - cancellation is **D**, not C;
 *   - **RIC** is a category in its own right, for a retail cut-off bid;
 *   - a cut-off bid carries the **floor price**, never zero
 *     ("Please mention floor price when category is RIC");
 *   - a file carries at most **100 records**, so a larger book must be split.
 * Comma or pipe separated .csv/.txt are both accepted.
 */
const { toCsv, toPipe, sha256, stamp, effectivePrice } = require('./common');

const EXCHANGE = 'BSE';
const FORMAT = 'csv';
const MAX_ROWS = 100;                    // per the guidelines

/** Column names, for the desk's on-screen preview only — the file itself has no header. */
const HEADER = ['OFS Symbol', 'Category', 'Client/CP Code', 'UCC', 'Custodian Code',
                'Qty', 'Price', 'Margin', 'Bid Id', 'Action Code'];

// Notice 20150122-30, Annexure 1: "i.e. IC, MF, OTHS, NII, RI and/or RIC".
// RIC was missing, so every retail cut-off bid was being coerced to RI.
const VALID_CATEGORIES = ['MF', 'IC', 'OTHS', 'NII', 'RI', 'RIC'];

/**
 * BSE categories. Non-institutional is NII; retail is RI for a price bid and
 * **RIC for a cut-off bid** — cut-off IS a category here, not merely a price. The
 * pair (RIC, floor price) is what the exchange matches on, so getting either half
 * wrong rejects the row.
 */
function categoryCode(bid, settings) {
  const code = bid.category === 'HNI'
    ? (settings.cat_hni || 'NII')
    : bid.is_cutoff
      ? (settings.cat_retail_cutoff || 'RIC')
      : (settings.cat_retail || 'RI');
  if (VALID_CATEGORIES.includes(code)) return code;
  return bid.category === 'HNI' ? 'NII' : (bid.is_cutoff ? 'RIC' : 'RI');
}

/** N new · M modify · D delete. */
function actionCode(bid) {
  if (bid.status === 'Cancelled') return 'D';
  if (bid.status === 'Modified') return 'M';
  return 'N';
}

function row(bid, issue, settings) {
  return [
    String(issue.symbol || '').slice(0, 10),
    categoryCode(bid, settings),
    String(bid.cp_code || '').slice(0, 16),
    String(bid.client_ucc || '').toUpperCase().slice(0, 12),
    String(bid.custody_code || '').slice(0, 12),
    Number(bid.qty) || 0,
    effectivePrice(bid, issue, settings).toFixed(2),
    Number(settings.margin_type) === 1 ? 1 : 2,
    bid.exch_order_no || 0,              // 0 for a new record
    actionCode(bid)
  ];
}

/**
 * Build the file. `opts.part` (1-based) selects a slice when the book exceeds 100
 * rows; `parts` in the result says how many there are, so the desk uploads all of
 * them rather than silently sending the first hundred.
 */
function build(bids, settings, opts) {
  opts = opts || {};
  const all = bids.map((b) => row(b, b.issue, settings));
  const parts = Math.max(1, Math.ceil(all.length / MAX_ROWS));
  const part = Math.min(Math.max(1, Number(opts.part) || 1), parts);
  const body = all.slice((part - 1) * MAX_ROWS, part * MAX_ROWS);

  // No header row: iBBS reads the first line as data.
  const text = opts.pipe ? toPipe(body) : toCsv(body);

  return {
    exchange: EXCHANGE,
    format: FORMAT,
    fileName: fileName(opts.symbol, parts > 1 ? part : null),
    mime: 'text/csv',
    text,
    rowCount: body.length,
    totalRows: all.length,
    parts,
    part,
    maxRowsPerFile: MAX_ROWS,
    totalQty: body.reduce((t, r) => t + Number(r[5] || 0), 0),
    totalValue: body.reduce((t, r) => t + Number(r[5] || 0) * Number(r[6] || 0), 0),
    checksum: sha256(text),
    header: HEADER,
    hasHeaderRow: false
  };
}

function fileName(symbol, part) {
  return 'BSE_OFS_Bid_' + (symbol || 'ALL') + '_' + stamp() +
         (part ? '_part' + part : '') + '.csv';
}

module.exports = { EXCHANGE, FORMAT, HEADER, MAX_ROWS, VALID_CATEGORIES,
                   categoryCode, actionCode, row, build, fileName };
