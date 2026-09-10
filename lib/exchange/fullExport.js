'use strict';
/**
 * The desk's own bid extract — everything about a bid, including who placed it and
 * when. NOT an exchange file, and deliberately not shaped like one.
 *
 * The exchange files carry exactly the fields NSE and BSE document and nothing else:
 * an extra column is a rejected upload, so no timestamp, no actor, no reference
 * belongs in them. But the desk still has to answer "who put this in, and when" for
 * compliance, for reconciliation against the exchange's own bid book, and for the
 * next morning's argument. That is what this is for.
 *
 * One row per bid, columns in a fixed order — a report that reorders its columns
 * between runs cannot be diffed against yesterday's.
 */
const { toCsv, sha256, stamp, istStamp, effectivePrice, actionCodeFor } = require('./common');
const nse = require('./nse');
const bse = require('./bse');

const HEADER = [
  // identity
  'Bid Ref', 'Bid Id', 'Status',
  // the issue
  'Symbol', 'Company', 'ISIN', 'Exchange', 'BSE Scrip Code', 'Trading Day',
  'Floor Price', 'Retail Cut-off Min', 'Tick', 'Lot', 'Retail Discount %',
  // the bid as the desk sees it
  'Category', 'NSE Series', 'BSE Category', 'Action Code (NSE)', 'Action Code (BSE)',
  'Client UCC', 'CP Code', 'Custodian Code',
  'Quantity', 'Bid Type', 'Bid Price', 'Price Sent to Exchange', 'Order Value',
  'Margin Type', 'Exchange Order No', 'Reject Reason',
  // audit
  'Placed By', 'Placed By Id', 'OTP Verified', 'Placed At (IST)', 'Last Changed (IST)'
];

function row(b, settings) {
  const i = b.issue || {};
  const cutoff = !!b.is_cutoff;
  return [
    b.ref || '',
    b.id == null ? '' : b.id,
    b.status || '',

    i.symbol || '',
    i.company || '',
    i.isin || '',
    i.exchange || '',
    i.bse_scrip_code || '',
    i.issue_date ? String(i.issue_date).slice(0, 10) : '',
    i.floor_price == null ? '' : Number(i.floor_price).toFixed(2),
    i.cut_price_min == null ? '' : Number(i.cut_price_min).toFixed(2),
    i.tick == null ? '' : i.tick,
    i.lot == null ? '' : i.lot,
    i.discount_pct == null ? '' : i.discount_pct,

    b.category || '',
    nse.seriesFor(b, settings),
    bse.categoryCode(b, settings),
    actionCodeFor('NSE', b),
    actionCodeFor('BSE', b),
    String(b.client_ucc || '').toUpperCase(),
    b.cp_code || '',
    b.custody_code || '',

    Number(b.qty) || 0,
    cutoff ? 'Cut-off' : 'Limit',
    cutoff ? '' : (b.price == null ? '' : Number(b.price).toFixed(2)),
    // What the file would actually carry for this bid — a cut-off row goes out at
    // the floor price on BSE, so the two differ and both are worth having.
    effectivePrice(b, i, settings).toFixed(2),
    b.value == null ? '' : Number(b.value).toFixed(2),
    Number(settings.margin_type) === 1 ? '0% margin' : '100% upfront',
    b.exch_order_no || '',
    b.reject_reason || '',

    b.placed_by || '',
    b.placed_by_id || '',
    b.otp_verified === true ? 'Yes' : 'No',
    istStamp(b.created_at),
    istStamp(b.updated_at)
  ];
}

/** bids: rows joined to their issue as { ...bid, issue }. */
function build(bids, settings, opts) {
  opts = opts || {};
  const body = (bids || []).map((b) => row(b, settings || {}));
  const text = toCsv([HEADER].concat(body));
  return {
    exchange: 'ALL',
    format: 'csv',
    fileName: 'OFS_Bids_Full_' + (opts.symbol || 'ALL') + '_' + stamp() + '.csv',
    mime: 'text/csv',
    text,
    rowCount: body.length,
    totalQty: (bids || []).reduce((t, b) => t + (Number(b.qty) || 0), 0),
    totalValue: (bids || []).reduce((t, b) => t + (Number(b.value) || 0), 0),
    checksum: sha256(text),
    header: HEADER,
    hasHeaderRow: true,
    bidIds: (bids || []).map((b) => b.id)
  };
}

module.exports = { EXCHANGE: 'ALL', FORMAT: 'csv', HEADER, row, build };
