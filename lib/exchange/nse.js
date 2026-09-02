'use strict';
/**
 * NSE e-OFS bulk bid file.
 *
 * Rebuilt 2 Sep 2026 from **NSE "Offer for Sale System WEB API Protocol" v1.3.0
 * (Feb 2024)**, the order-entry contract that the bulk upload mirrors:
 *   https://nsearchives.nseindia.com/web/sites/default/files/inline-files/OFS-WEB%20API_Ver1.3.pdf
 *
 * It previously emitted BSE's ten-column layout. That was wrong in almost every
 * respect, and the differences are not cosmetic — each one on its own would have had
 * the file rejected:
 *
 *   BSE                                  NSE
 *   Category RI / RIC / NII              no category field at all; `series` + `clientType`
 *   Action   N / M / D                   operationType  E / M / C  (and CF for carry-forward)
 *   Margin   1 = 0%, 2 = 100%            marginType     0 = 0%, 1 = 100%   ← inverted
 *   cut-off  category RIC, floor price   isMarketOrder = true, price BLANK
 *   UCC in a UCC column                  clientId
 *
 * The margin flag being inverted is the nastiest of them: a file would upload
 * cleanly and block the wrong margin.
 *
 * ── STILL UNCONFIRMED, and it is the column ORDER ──
 * v1.3.0 gives the field set and the values authoritatively. It does not state the
 * CSV column order for /order/batch, and NSE's own operating guidelines
 * (circular **NSE/CMTR/72975**, 24 Feb 2026) are member-only. The order below is the
 * order the protocol lists the fields in, which is the best available inference —
 * pin it against that circular before the first live upload. Everything else here
 * is quoted from the document.
 */
const { toCsv, sha256, stamp, actionCodeFor } = require('./common');

const EXCHANGE = 'NSE';
const FORMAT = 'csv';

/**
 * Series. v1.3.0 allows IS, RS and ES but does not say what they stand for, so the
 * mapping is a SETTING rather than a guess baked into code. The names are the
 * obvious reading — Institutional / Retail / Employee — and that reading is exactly
 * what NSE/CMTR/72975 must confirm.
 */
const VALID_SERIES = ['IS', 'RS', 'ES'];

function seriesFor(bid, issue, settings) {
  const s = settings || {};
  const code = bid.category === 'HNI'
    ? (s.nse_series_hni || 'IS')
    : (s.nse_series_retail || 'RS');
  return VALID_SERIES.indexOf(code) >= 0 ? code : (bid.category === 'HNI' ? 'IS' : 'RS');
}

/** PRO for the member's own book, CLI for a client. OFS on behalf of a client is CLI. */
function clientType(bid) {
  return String(bid.pro_client || '').toUpperCase() === 'PRO' ? 'PRO' : 'CLI';
}

/**
 * marginType — "For 100% Margin - 1 For 0% Margin - 0" (v1.3.0).
 *
 * Note the inversion against BSE, where 1 means 0% and 2 means 100%. `margin_type`
 * in settings is stored in BSE's numbering because that is what the desk sees, so it
 * is translated here rather than being written through.
 */
function marginType(settings) {
  return Number((settings || {}).margin_type) === 1 ? 0 : 1;
}

/** A cut-off bid is a MARKET order with a blank price — not a price of any kind. */
function isMarketOrder(bid) {
  return bid.is_cutoff === true;
}

function priceCell(bid) {
  // "In case if Market orders this field should be blank."
  if (isMarketOrder(bid)) return '';
  return (Math.round(Number(bid.price) * 100) / 100).toFixed(2);
}

/** Field order as the protocol lists them. See the header note — this is the open item. */
const HEADER = [
  'symbol', 'series', 'clientType', 'clientId', 'participantId',
  'marginType', 'isMarketOrder', 'quantity', 'price', 'operationType', 'orderId'
];

function row(bid, issue, settings) {
  return [
    String(issue.symbol || '').slice(0, 10),
    seriesFor(bid, issue, settings),
    clientType(bid),
    String(bid.client_ucc || '').toUpperCase().slice(0, 10),
    String(bid.participant_id || bid.cp_code || '').slice(0, 12),
    marginType(settings),
    isMarketOrder(bid) ? 'true' : 'false',
    Number(bid.qty) || 0,
    priceCell(bid),
    actionCodeFor(EXCHANGE, bid),          // E new · M modify · C cancel
    bid.exch_order_no || ''                // "Blank for new entries"
  ];
}

/** bids: rows joined to their issue as { ...bid, issue }. */
function build(bids, settings, opts) {
  opts = opts || {};
  const body = (bids || []).map((b) => row(b, b.issue, settings));
  const rows = opts.noHeader ? body : [HEADER].concat(body);
  const text = toCsv(rows);

  // Value uses the price actually written; a market order contributes none, which is
  // correct — its value is not known until the clearing price is struck.
  const totalQty = body.reduce((t, r) => t + Number(r[7] || 0), 0);
  const totalValue = body.reduce((t, r) => t + Number(r[7] || 0) * Number(r[8] || 0), 0);

  return {
    exchange: EXCHANGE,
    format: FORMAT,
    fileName: fileName(opts.symbol),
    mime: 'text/csv',
    text,
    rowCount: body.length,
    totalQty,
    totalValue,
    checksum: sha256(text),
    header: HEADER,
    unverified: 'Column ORDER is inferred from the v1.3.0 field list; confirm against NSE/CMTR/72975.'
  };
}

function fileName(symbol) {
  return 'NSE_OFS_Bid_' + (symbol || 'ALL') + '_' + stamp() + '.csv';
}

module.exports = { EXCHANGE, FORMAT, HEADER, VALID_SERIES,
  seriesFor, clientType, marginType, isMarketOrder, row, build, fileName };
