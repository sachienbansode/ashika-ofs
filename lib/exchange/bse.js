'use strict';
/**
 * BSE iBBS OFS bulk-bid adapter.
 *
 * !! PIN BEFORE GO-LIVE !!  The layout is defined in BSE Notice 20120727-26
 * (point 3.3.4) and the BSE OFS comprehensive guidelines. Obtain the current
 * file from the BSE member portal and match it byte-for-byte: iBBS files are
 * typically a member/trading-code header line followed by pipe- or comma-
 * separated bid rows. Everything below is the representative field set only.
 */
const { toCsv, sha256, stamp, effectivePrice, actionCode } = require('./common');

const EXCHANGE = 'BSE';
const FORMAT = 'csv';

const HEADER = [
  'Member Code', 'Scrip Code', 'ISIN', 'Client Code', 'Client Type',
  'Quantity', 'Rate', 'Cut Off Flag', 'Bid Reference', 'Action'
];

/** BSE distinguishes Retail (RI) from Non-Retail (NII); cut-off is a flag, not a category. */
function clientType(bid, settings) {
  return bid.category === 'HNI' ? (settings.cat_hni || 'NII') : (settings.cat_retail || 'RI');
}

function row(bid, issue, settings, memberCode) {
  return [
    memberCode || '',
    issue.bse_scrip_code || '',            // TODO: add scrip_code to ofs_issue once BSE masters confirmed
    String(issue.isin || '').toUpperCase(),
    String(bid.client_ucc || '').toUpperCase(),
    clientType(bid, settings),
    Number(bid.qty) || 0,
    effectivePrice(bid, issue, settings),
    bid.is_cutoff ? 'Y' : 'N',
    bid.exch_order_no || bid.ref || '',
    actionCode(bid)
  ];
}

function build(bids, settings, opts) {
  opts = opts || {};
  const member = opts.memberCode || process.env.BSE_MEMBER_CODE || '';
  const body = bids.map((b) => row(b, b.issue, settings, member));
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
  return 'BSE_OFS_Bid_' + (symbol || 'ALL') + '_' + stamp() + '.csv';
}

module.exports = { EXCHANGE, FORMAT, HEADER, clientType, row, build, fileName };
