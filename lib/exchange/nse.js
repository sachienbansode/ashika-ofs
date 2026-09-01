'use strict';
/**
 * NSE OFS bulk-upload adapter.
 *
 * !! PIN BEFORE GO-LIVE !!  Column order and header text change by circular.
 * The layout below is the representative field set from the spec (S7.1) and the
 * ashika-ofs-bidding.html prototype's export. Replace HEADER/row() with the exact
 * columns from the current NSE OFS bulk-upload spec (NSE OFS Web API Protocol
 * v1.3 references the live field list) obtained from the member portal.
 * Recent NSE versions dropped "order type" - confirm.
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
