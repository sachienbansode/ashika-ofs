'use strict';
/**
 * NSE OFS bulk-upload adapter.
 *
 * !! PIN BEFORE GO-LIVE !!
 *
 * The field set below matches BSE's documented OFS bulk-bid layout, which the
 * prototype also used. NSE's own layout is NOT public: the e-OFS FAQ points to the
 * Web API protocol docs and to circular NSE/CMTR/72975 (24 Feb 2026) for the
 * operating guidelines, both member-only. Get that circular from the member portal
 * and reconcile three things in particular:
 *
 *   - the action code for a cancellation. BSE documents D; this adapter still emits
 *     C, which is what the prototype used. One of them is wrong for NSE.
 *   - whether a header row is expected. BSE takes none.
 *   - the maximum records per file. BSE caps at 100; NSE's cap is unknown here.
 *
 * Until then treat NSE output as unverified. tests/exchange.test.js pins the current
 * behaviour, so a correction shows up as a failing assertion rather than a surprise.
 */
const { toCsv, sha256, stamp, effectivePrice, actionCode } = require('./common');

const EXCHANGE = 'NSE';
const FORMAT = 'csv';

const HEADER = [
  'OFS Symbol', 'Category', 'Client/CP Code', 'UCC', 'Custody Code',
  'Qty', 'Price', 'Margin Type', 'Bid Id', 'Action Code'
];

/** Exchange category code for a bid. Retail cut-off gets its own code (RIC). */
function categoryCode(bid, settings) {
  if (bid.category === 'HNI') return settings.cat_hni || 'NII';
  return bid.is_cutoff ? (settings.cat_retail_cutoff || 'RIC') : (settings.cat_retail || 'RI');
}

function row(bid, issue, settings) {
  return [
    issue.symbol,
    categoryCode(bid, settings),
    bid.cp_code || '',
    String(bid.client_ucc || '').toUpperCase(),
    bid.custody_code || '',
    Number(bid.qty) || 0,
    effectivePrice(bid, issue, settings),
    Number(settings.margin_type) || 0,
    bid.exch_order_no || 0,          // exchange bid/order no. for M/C rows; 0 for new
    actionCode(bid)
  ];
}

/** bids: rows joined to their issue as { ...bid, issue }. */
function build(bids, settings, opts) {
  opts = opts || {};
  const body = bids.map((b) => row(b, b.issue, settings));
  const rows = opts.noHeader ? body : [HEADER].concat(body);
  const text = toCsv(rows);
  return {
    exchange: EXCHANGE,
    format: FORMAT,
    fileName: fileName(opts.symbol),
    mime: 'text/csv',
    text,
    rowCount: body.length,
    totalQty: body.reduce((t, r) => t + Number(r[5] || 0), 0),
    totalValue: body.reduce((t, r) => t + Number(r[5] || 0) * Number(r[6] || 0), 0),
    checksum: sha256(text),
    header: HEADER
  };
}

function fileName(symbol) {
  return 'NSE_OFS_Bid_' + (symbol || 'ALL') + '_' + stamp() + '.csv';
}

module.exports = { EXCHANGE, FORMAT, HEADER, categoryCode, row, build, fileName };
