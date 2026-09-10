'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const nse = require('../lib/exchange/nse');
const bse = require('../lib/exchange/bse');
const { adapterFor } = require('../lib/exchange');
const { ISSUE, SETTINGS } = require('./fixtures');

const BIDS = [
  { client_ucc: 'ash1001', category: 'Retail', qty: 500, price: 390, is_cutoff: false, status: 'Live', ref: 'R1', issue: ISSUE },
  { client_ucc: 'ASH2001', category: 'HNI', qty: 1000, price: 392.5, is_cutoff: false, status: 'Live', ref: 'R2', issue: ISSUE, cp_code: 'CP01' },
  { client_ucc: 'ASH1002', category: 'Retail', qty: 100, price: null, is_cutoff: true, status: 'Cancelled', ref: 'R3', issue: ISSUE },
  { client_ucc: 'ASH1003', category: 'Retail', qty: 200, price: 388, is_cutoff: false, status: 'Modified', ref: 'R4', issue: ISSUE, exch_order_no: '99001' }
];

test('adapterFor resolves by name and rejects anything else', () => {
  assert.equal(adapterFor('nse'), nse);
  assert.equal(adapterFor('BSE'), bse);
  assert.throws(() => adapterFor('MCX'), /Unknown exchange/);
});

/* ===================================================================== NSE ===
 * From "NSE Offer for Sale System WEB API Protocol" v1.3.0 (Feb 2024). The point of
 * these is that NSE's file is NOT BSE's: every one of these assertions was the other
 * way round while the NSE adapter was a copy of the BSE one.
 */

test('NSE writes its own field set — no category column exists', () => {
  const out = nse.build(BIDS, SETTINGS, { symbol: 'COALINDIA' });
  const lines = out.text.split('\r\n').filter(Boolean);
  assert.equal(lines[0], nse.HEADER.join(','));
  assert.equal(out.rowCount, 4);
  assert.equal(out.totalQty, 1800);

  // The BSE category codes must appear nowhere at all.
  assert.ok(!/\bRIC?\b|\bNII\b|\bOTHS\b/.test(out.text), 'no BSE category code may leak into an NSE file');
  assert.ok(out.header.includes('series') && out.header.includes('clientType'));
  assert.ok(!out.header.includes('Category'));
});

test('NSE series and clientType replace the category', () => {
  // v1.3.0 allows IS, RS, ES. The meanings are not stated in the document, so the
  // mapping is a setting — and an unrecognised value must never reach the exchange.
  assert.deepEqual(nse.VALID_SERIES, ['IS', 'RS', 'ES']);
  assert.equal(nse.seriesFor({ category: 'HNI' }, null, SETTINGS), 'IS');
  assert.equal(nse.seriesFor({ category: 'Retail' }, null, SETTINGS), 'RS');
  const junk = Object.assign({}, SETTINGS, { nse_series_hni: 'ZZ', nse_series_retail: 'QQ' });
  assert.equal(nse.seriesFor({ category: 'HNI' }, null, junk), 'IS');
  assert.equal(nse.seriesFor({ category: 'Retail' }, null, junk), 'RS');

  assert.equal(nse.clientType({}), 'CLI', 'bidding on behalf of a client is CLI');
  assert.equal(nse.clientType({ pro_client: 'PRO' }), 'PRO');
});

test('NSE margin flag is INVERTED against BSE', () => {
  // v1.3.0: "For 100% Margin - 1 For 0% Margin - 0."  BSE: 1 = 0%, 2 = 100%.
  // Writing BSE's number through would upload cleanly and block the wrong margin.
  assert.equal(nse.marginType({ margin_type: '2' }), 1, '100% upfront is 1 at NSE');
  assert.equal(nse.marginType({ margin_type: '1' }), 0, '0% margin is 0 at NSE');
});

test('an NSE cut-off bid is a MARKET order with a blank price', () => {
  // v1.3.0: "In case if Market orders this field should be blank." Not the floor
  // price — that is BSE's rule, for BSE's RIC category.
  const cut = BIDS.find((b) => b.is_cutoff);
  assert.equal(nse.isMarketOrder(cut), true);
  const line = nse.build([cut], SETTINGS, {}).text.split('\r\n')[1];
  assert.ok(/,true,100,,/.test(line), 'market order, quantity, then an empty price: ' + line);
});

test('NSE operation codes are E / M / C — not BSE\'s N / M / D', () => {
  // v1.3.0 operationType: "'E' - Place Order, 'M' - Modify Order, 'C' - Cancel Order".
  // The shared helper used to hand NSE whichever code BSE needed.
  const lines = nse.build(BIDS, SETTINGS, {}).text.split('\r\n').filter(Boolean);
  assert.ok(/,E,/.test(lines[1]) || lines[1].endsWith(',E,'), 'a new bid is E: ' + lines[1]);
  assert.ok(/,C,/.test(lines[3]), 'a cancellation is C at NSE: ' + lines[3]);
  assert.ok(/,M,/.test(lines[4]), 'a modification is M: ' + lines[4]);
  assert.ok(lines[4].includes('99001'), 'modify carries the exchange order id');
  assert.ok(lines[1].endsWith(','), 'orderId is blank for a new entry: ' + lines[1]);
});

/* ===================================================================== BSE === */

test('BSE cut-off bids carry the FLOOR PRICE in category RIC', () => {
  // Notice 20150122-30 twice over: Annexure 1, "Please mention floor price when
  // category is RIC"; 4.3.5, "Margin for bids placed at cut-off price shall be at
  // the floor price". A zero fails the exchange's at-or-above-floor check.
  const text = bse.build(BIDS, SETTINGS, {}).text;
  assert.ok(/RIC,,ASH1002,,100,385\.00,/.test(text), 'RIC at the floor price: ' + text);

  const asZero = Object.assign({}, SETTINGS, { cutoff_price_mode: 'zero' });
  assert.ok(/RIC,,ASH1002,,100,0\.00,/.test(bse.build(BIDS, asZero, {}).text));
});

test('BSE action codes are N / M / D', () => {
  const lines = bse.build(BIDS, SETTINGS, {}).text.split('\r\n').filter(Boolean);
  assert.ok(lines[0].endsWith(',N'), 'no header row, and the first bid is N');
  assert.ok(lines[2].endsWith(',D'), 'a cancellation is D at BSE, never C');
  assert.ok(lines[3].endsWith(',M'));
});

test('exchange files are CRLF and checksummed over the exact bytes', () => {
  const out = nse.build(BIDS, SETTINGS, {});
  assert.ok(out.text.includes('\r\n'));
  assert.ok(/^[0-9a-f]{64}$/.test(out.checksum));
  assert.equal(nse.build(BIDS, SETTINGS, {}).checksum, out.checksum, 'same input, same checksum');
  assert.notEqual(nse.build(BIDS.slice(0, 2), SETTINGS, {}).checksum, out.checksum);
});

test('BSE file matches the published guidelines layout', () => {
  // BSE Comprehensive Amended Guidelines, OFS Segment — ten fields, no header row.
  const out = bse.build(BIDS, SETTINGS, { symbol: 'COALINDIA' });
  const lines = out.text.split('\r\n').filter(Boolean);

  assert.equal(out.hasHeaderRow, false, 'iBBS reads the first line as data');
  assert.notEqual(lines[0], bse.HEADER.join(','));
  assert.equal(lines.length, 4, 'four bids, four lines');

  const f = lines[0].split(',');
  assert.equal(f.length, 10, 'exactly ten fields');
  assert.equal(f[0], 'COALINDIA');   // OFS Symbol
  assert.equal(f[1], 'RI');          // Category
  assert.equal(f[3], 'ASH1001');     // UCC, uppercased
  assert.equal(f[5], '500');         // Qty
  assert.equal(f[6], '390.00');      // Price, two decimals
  assert.equal(f[7], '2');           // Margin: 100% upfront
  assert.equal(f[8], '0');           // Bid Id: 0 for a new record
  assert.equal(f[9], 'N');           // Action
});

test('BSE cancellation is D, not C', () => {
  const lines = bse.build(BIDS, SETTINGS, {}).text.split('\r\n').filter(Boolean);
  assert.equal(lines[2].split(',')[9], 'D', 'the guidelines specify D for deletion');
  assert.equal(lines[3].split(',')[9], 'M');
  assert.equal(bse.actionCode({ status: 'Live' }), 'N');
});

test('BSE categories are the published set, RIC included', () => {
  // Notice 20150122-30, Annexure 1: "i.e. IC, MF, OTHS, NII, RI and/or RIC".
  // RIC was missing, so every retail cut-off bid was being coerced to RI.
  assert.deepEqual(bse.VALID_CATEGORIES, ['MF', 'IC', 'OTHS', 'NII', 'RI', 'RIC']);

  // Cut-off is a CATEGORY at BSE, not merely a price.
  assert.equal(bse.categoryCode({ category: 'Retail', is_cutoff: true }, SETTINGS), 'RIC');
  assert.equal(bse.categoryCode({ category: 'Retail', is_cutoff: false }, SETTINGS), 'RI');

  // An unrecognised code from settings must never reach the exchange.
  const odd = Object.assign({}, SETTINGS, { cat_retail: 'ZZ', cat_hni: 'QQ', cat_retail_cutoff: 'XX' });
  assert.equal(bse.categoryCode({ category: 'Retail' }, odd), 'RI');
  assert.equal(bse.categoryCode({ category: 'Retail', is_cutoff: true }, odd), 'RIC');
  assert.equal(bse.categoryCode({ category: 'HNI' }, odd), 'NII');
});

test('BSE splits a book over 100 rows into numbered files', () => {
  const many = [];
  for (let i = 0; i < 250; i++) {
    many.push(Object.assign({}, BIDS[0], { client_ucc: 'C' + i, ref: 'R' + i }));
  }
  const p1 = bse.build(many, SETTINGS, { symbol: 'X', part: 1 });
  assert.equal(p1.parts, 3);
  assert.equal(p1.rowCount, 100);
  assert.equal(p1.totalRows, 250);
  assert.match(p1.fileName, /_part1\.csv$/);

  const p3 = bse.build(many, SETTINGS, { symbol: 'X', part: 3 });
  assert.equal(p3.rowCount, 50, 'the remainder');
  assert.notEqual(p3.checksum, p1.checksum);

  // out-of-range parts clamp rather than producing an empty file
  assert.equal(bse.build(many, SETTINGS, { part: 99 }).part, 3);
  assert.equal(bse.build(many, SETTINGS, { part: 0 }).part, 1);
  // a small book is still one part
  assert.equal(bse.build(BIDS, SETTINGS, {}).parts, 1);
});

test('BSE accepts a pipe-separated file too', () => {
  const out = bse.build(BIDS, SETTINGS, { pipe: true });
  assert.ok(out.text.split('\r\n')[0].split('|').length === 10);
});

test('file names carry the exchange, symbol and part', () => {
  assert.match(nse.fileName('COALINDIA'), /^NSE_OFS_Bid_COALINDIA_\d{8}_\d{4}\.csv$/);
  assert.match(bse.fileName(null), /^BSE_OFS_Bid_ALL_\d{8}_\d{4}\.csv$/);
  assert.match(bse.fileName('X', 2), /^BSE_OFS_Bid_X_\d{8}_\d{4}_part2\.csv$/);
});

test('a field containing a comma is quoted, not split', () => {
  const bids = [Object.assign({}, BIDS[0], { cp_code: 'A,B' })];
  assert.ok(nse.build(bids, SETTINGS, {}).text.includes('"A,B"'));
  assert.ok(bse.build(bids, SETTINGS, {}).text.includes('"A,B"'));
});

test('BSE truncates to the published field lengths', () => {
  const long = [Object.assign({}, BIDS[0], {
    client_ucc: 'ASH1001234567890',           // UCC is alphanumeric(12)
    cp_code: 'C'.repeat(30),                  // Client/CP code is alphanumeric(16)
    issue: Object.assign({}, ISSUE, { symbol: 'VERYLONGSYMBOL' })  // symbol is (10)
  })];
  const f = bse.build(long, SETTINGS, {}).text.split('\r\n')[0].split(',');
  assert.equal(f[0].length, 10);
  assert.equal(f[2].length, 16);
  assert.equal(f[3].length, 12);
});

test('an empty book produces a header-only file with zero rows', () => {
  const out = nse.build([], SETTINGS, {});
  assert.equal(out.rowCount, 0);
  assert.equal(out.totalQty, 0);
  assert.equal(out.text.trim(), nse.HEADER.join(','));
});

/* ---------------------------------------------------------------- header rows --
 * The desk's preview reads hasHeaderRow to decide whether line 1 of the file is a
 * bid or a column list. It used to assume line 1 was always a header, so on BSE —
 * which documents no header row — the first bid was drawn as the table head and
 * never shown as a row: two bids exported, one bid displayed. These pin the
 * contract that fix depends on.
 */
const nseAd = require('../lib/exchange/nse');
const bseAd = require('../lib/exchange/bse');

function twoBids() {
  const issue = { symbol: 'COALINDIA', isin: 'INE522F01014', floor_price: 400, tick: 0.05, lot: 1 };
  return [
    { client_ucc: 'S247674', category: 'Retail', qty: 1, price: 400, is_cutoff: false, status: 'Live', issue },
    { client_ucc: 'A136386', category: 'Retail', qty: 2, price: 1000, is_cutoff: false, status: 'Live', issue }
  ];
}
const BASE = { margin_type: '2', cat_retail: 'RI', cat_retail_cutoff: 'RIC', cat_hni: 'NII',
               nse_series_retail: 'RS', nse_series_hni: 'IS' };
const lines = (t) => t.split(/\r?\n/).filter(Boolean);

test('BSE writes no header row, so every line is a bid', () => {
  const out = bseAd.build(twoBids(), BASE, {});
  assert.equal(out.hasHeaderRow, false);
  assert.equal(lines(out.text).length, out.rowCount);
  assert.match(lines(out.text)[0], /^COALINDIA,RI,/);
  assert.ok(out.header.length, 'column names are still published for the preview');
});

test('NSE writes a header row by default, and the count reflects it', () => {
  const out = nseAd.build(twoBids(), BASE, {});
  assert.equal(out.hasHeaderRow, true);
  assert.equal(lines(out.text).length, out.rowCount + 1);
  assert.equal(lines(out.text)[0], out.header.join(','));
});

test('nse_header_row = 0 drops it, and says so', () => {
  const out = nseAd.build(twoBids(), Object.assign({}, BASE, { nse_header_row: '0' }), {});
  assert.equal(out.hasHeaderRow, false);
  assert.equal(lines(out.text).length, out.rowCount);
  assert.match(lines(out.text)[0], /^COALINDIA,RS,CLI,/);
});

test('an explicit noHeader option still wins over the setting', () => {
  const on = nseAd.build(twoBids(), Object.assign({}, BASE, { nse_header_row: '0' }), { noHeader: false });
  assert.equal(on.hasHeaderRow, true);
  const off = nseAd.build(twoBids(), Object.assign({}, BASE, { nse_header_row: '1' }), { noHeader: true });
  assert.equal(off.hasHeaderRow, false);
});

test('every column name has a cell, on both exchanges', () => {
  for (const [name, out] of [['NSE', nseAd.build(twoBids(), BASE, {})],
                             ['BSE', bseAd.build(twoBids(), BASE, {})]]) {
    const body = out.hasHeaderRow ? lines(out.text).slice(1) : lines(out.text);
    for (const l of body) {
      assert.equal(l.split(',').length, out.header.length,
        name + ' row has ' + l.split(',').length + ' cells for ' + out.header.length + ' columns: ' + l);
    }
  }
});

/* ------------------------------------------------- audit fields stay off the wire --
 * The desk asked to see when a bid was placed and by whom, and asked for that NOT to
 * be in the exchange file. Both halves matter: an exchange accepts the documented
 * fields and nothing else, so one extra column is a rejected upload. These tests are
 * the guard against someone helpfully adding a timestamp to a file adapter later.
 */
const fullAd = require('../lib/exchange/fullExport');
const { istStamp } = require('../lib/exchange/common');

function auditedBids() {
  const issue = { id: 5, symbol: 'COALINDIA', company: 'Coal India Ltd', isin: 'INE522F01014',
                  exchange: 'BOTH', floor_price: 400, cut_price_min: 400, tick: 0.05, lot: 1,
                  discount_pct: 0, issue_date: '2026-09-10' };
  return [
    { id: 11, ref: 'OFS260910-AAA', status: 'Live', client_ucc: 'S247674', category: 'Retail',
      qty: 1, price: 400, is_cutoff: false, value: 400, placed_by: 'client', placed_by_id: 'S247674',
      otp_verified: true, created_at: '2026-09-10T04:19:00Z', updated_at: '2026-09-10T04:19:00Z', issue },
    { id: 12, ref: 'OFS260910-BBB', status: 'Live', client_ucc: 'A136386', category: 'Retail',
      qty: 2, price: null, is_cutoff: true, value: 800, placed_by: 'desk',
      placed_by_id: 'someone@ashikagroup.com',
      created_at: '2026-09-10T05:01:10Z', updated_at: '2026-09-10T05:20:00Z', issue }
  ];
}
const AUD = { margin_type: '2', cat_retail: 'RI', cat_retail_cutoff: 'RIC', cat_hni: 'NII',
              nse_series_retail: 'RS', nse_series_hni: 'IS', cutoff_price_mode: 'floor' };

for (const [name, adapter] of [['NSE', nseAd], ['BSE', bseAd]]) {
  test(name + ' file carries no timestamp, no actor and no internal reference', () => {
    const text = adapter.build(auditedBids(), AUD, {}).text;
    assert.ok(!/OFS260910-/.test(text), 'internal bid ref leaked into the ' + name + ' file');
    assert.ok(!/someone@ashikagroup\.com/.test(text), 'actor leaked into the ' + name + ' file');
    assert.ok(!/2026-09-10 \d\d:/.test(text), 'a timestamp leaked into the ' + name + ' file');
    assert.ok(!/\bdesk\b|\bclient\b/.test(text), 'placed_by leaked into the ' + name + ' file');
  });
}

test('the full extract carries all of it, and says so in IST', () => {
  const out = fullAd.build(auditedBids(), AUD, {});
  assert.equal(out.rowCount, 2);
  assert.equal(out.hasHeaderRow, true);
  const rows = out.text.split(/\r?\n/).filter(Boolean);
  assert.equal(rows.length, 3);
  assert.equal(rows[0], fullAd.HEADER.join(','));
  assert.match(rows[1], /OFS260910-AAA/);
  assert.match(rows[1], /client,S247674,Yes/);
  // 04:19 UTC is 09:49 IST — the server runs UTC, so this is the bug being prevented.
  assert.match(rows[1], /2026-09-10 09:49:00/);
  assert.match(rows[2], /someone@ashikagroup\.com/);
});

test('a cut-off row shows both the blank bid price and the price the exchange gets', () => {
  const cells = fullAd.row(auditedBids()[1], AUD);
  const h = fullAd.HEADER;
  assert.equal(cells[h.indexOf('Bid Type')], 'Cut-off');
  assert.equal(cells[h.indexOf('Bid Price')], '');
  assert.equal(cells[h.indexOf('Price Sent to Exchange')], '400.00');
  assert.equal(cells[h.indexOf('BSE Category')], 'RIC');
});

test('every full-extract row has one cell per column name', () => {
  const out = fullAd.build(auditedBids(), AUD, {});
  for (const l of out.text.split(/\r?\n/).filter(Boolean)) {
    assert.equal((l.match(/,/g) || []).length + 1, fullAd.HEADER.length, l);
  }
});

test('bidIds are reported in file order, so screen columns line up with rows', () => {
  assert.deepEqual(nseAd.build(auditedBids(), AUD, {}).bidIds, [11, 12]);
  assert.deepEqual(bseAd.build(auditedBids(), AUD, {}).bidIds, [11, 12]);
});

test('a BSE part boundary keeps ids aligned with the lines in that part', () => {
  const many = [];
  for (let i = 0; i < 150; i++) {
    const b = Object.assign({}, auditedBids()[0], { id: 1000 + i, ref: 'R' + i });
    many.push(b);
  }
  const p2 = bseAd.build(many, AUD, { part: 2 });
  assert.equal(p2.rowCount, 50);
  assert.equal(p2.bidIds.length, 50);
  assert.equal(p2.bidIds[0], 1100);          // the 101st bid, not the first
  assert.equal(p2.bidIds[49], 1149);
});

test('istStamp is empty for a missing timestamp rather than "Invalid Date"', () => {
  assert.equal(istStamp(null), '');
  assert.equal(istStamp(''), '');
  assert.equal(istStamp('not a date'), '');
});
