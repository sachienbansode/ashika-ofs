'use strict';
/**
 * PostgreSQL rejections, said in words the desk can act on.
 *
 * Every constraint in db/migrations is there because something must not happen; when
 * one fires it is almost always the desk's input, not a fault. Letting those reach
 * the browser as 'server_error' hid the one thing the person needed — which field,
 * and what would make it acceptable.
 *
 * Returns null for anything genuinely ours, so a real 500 is still a 500.
 */

/** constraint name -> { field, message } */
const CONSTRAINTS = {
  ofs_issue_uq: {
    field: 'symbol',
    message: 'An issue with this symbol and ISIN already exists for that trading day. ' +
      'Edit the existing one, or change the HNI open date if this is a different offer.'
  },
  ofs_issue_exchange_ck: { field: 'exchange', message: 'Exchange must be NSE, BSE or BOTH.' },
  ofs_issue_status_ck:   { field: 'status',   message: 'Status must be Auto, Suspended, Closed or Withdrawn.' },
  ofs_issue_win_ck: {
    field: 'hni_close',
    message: 'Each window must close after it opens — check the HNI and Retail dates.'
  },
  ofs_issue_price_ck: {
    field: 'floor_price',
    message: 'Floor price must be above zero (or left blank if the seller has not published one), ' +
      'tick must be above zero, and lot must be at least 1.'
  },
  ofs_issue_alloc_ck: { field: 'allocation_method', message: 'Allocation method must be price priority or proportionate.' },
  ofs_bid_cat_ck:     { field: 'category', message: 'Category must be Retail or HNI.' },
  ofs_bid_qty_ck:     { field: 'qty', message: 'Quantity must be at least 1.' },
  ofs_bid_price_ck:   { field: 'price', message: 'A limit bid needs a price; only a cut-off bid may leave it blank.' },
  ofs_bid_one_live_uq: {
    field: 'client_ucc',
    message: 'This client already has a live bid on this issue. Modify that bid rather than placing another.'
  },
  ofs_bid_status_ck:  { field: 'status', message: 'Status must be Live, Modified, Cancelled or Rejected.' },
  ofs_bid_by_ck:      { field: 'placed_by', message: 'A bid must be recorded as placed by the desk, the client or an AP.' },
  ofs_margin_src_ck:  { field: 'source', message: 'Margin source must be manual, csv or rms.' },
  ofs_allot_uq:       { field: 'client_ucc', message: 'This client already has an allotment recorded for this issue.' },
  ofs_export_exch_ck: { field: 'exchange', message: 'Exchange must be NSE or BSE.' }
};

/** A column name the database mentions, in the words the form uses. */
const COLUMNS = {
  symbol: 'Symbol', company: 'Company', isin: 'ISIN', series: 'Series', exchange: 'Exchange',
  bse_scrip_code: 'BSE scrip code', floor_price: 'Floor price', cut_price_min: 'Retail cut-off min',
  tick: 'Tick', lot: 'Lot', issue_qty: 'Issue qty', retail_qty: 'Retail reserved qty',
  discount_pct: 'Retail discount %', cutoff_flag: 'Cut-off bidding',
  hni_open: 'HNI open', hni_close: 'HNI close', ret_open: 'Retail open', ret_close: 'Retail close',
  issue_date: 'Trading day', status: 'Status', client_ucc: 'Client UCC', qty: 'Quantity',
  price: 'Price', category: 'Category', available: 'Available margin'
};

function label(col) {
  return COLUMNS[col] || col;
}

/**
 * Translate a pg error. Returns { status, error, field, message } or null when the
 * error is not one the caller caused.
 */
function translate(e) {
  if (!e || !e.code) return null;
  const named = e.constraint && CONSTRAINTS[e.constraint];

  switch (e.code) {
    case '23505':   // unique_violation
      return named
        ? { status: 409, error: 'duplicate', field: named.field, message: named.message }
        : { status: 409, error: 'duplicate', message: 'A record with these details already exists.' };

    case '23514':   // check_violation
      return named
        ? { status: 422, error: 'check_failed', field: named.field, message: named.message }
        : { status: 422, error: 'check_failed',
            message: 'The database refused these values (' + (e.constraint || 'constraint') + ').' };

    case '23502':   // not_null_violation
      return { status: 400, error: 'missing_field', field: e.column,
               message: label(e.column) + ' is required.' };

    case '23503':   // foreign_key_violation
      return { status: 409, error: 'in_use',
               message: 'That record is referenced by something else and cannot be changed or removed.' };

    case '22P02':   // invalid_text_representation
      return { status: 400, error: 'bad_value',
               message: 'One of the values is not in the format the field expects — check the numbers and dates.' };

    case '22003':   // numeric_value_out_of_range
      return { status: 400, error: 'out_of_range', message: 'A number is too large for its field.' };

    case '22001':   // string_data_right_truncation
      return { status: 400, error: 'too_long', message: 'One of the values is longer than the field allows.' };

    default:
      return null;   // genuinely ours — let it be a 500
  }
}

/** Express helper: reply with the translation, or hand the error onward. */
function send(res, next, e) {
  const t = translate(e);
  if (!t) return next(e);
  return res.status(t.status).json({ error: t.error, field: t.field, message: t.message });
}

module.exports = { translate, send, label, CONSTRAINTS, COLUMNS };
