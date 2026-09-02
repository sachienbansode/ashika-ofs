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

test('NSE file: header, category codes, UCC case, totals', () => {
  const out = nse.build(BIDS, SETTINGS, { symbol: 'COALINDIA' });
  const lines = out.text.split('\r\n').filter(Boolean);
  assert.equal(lines[0], nse.HEADER.join(','));
  assert.equal(out.rowCount, 4);
  assert.equal(out.totalQty, 1800);
  assert.ok(lines[1].startsWith('COALINDIA,RI,,ASH1001,,500,390,2,0,N'), lines[1]);
  assert.ok(lines[2].includes('NII'), 'HNI maps to NII');
  assert.ok(lines[2].includes('CP01'), 'CP code carried through');
  assert.ok(lines[3].includes('RIC'), 'retail cut-off gets its own code');
});

test('action codes are N / M / D — D, not C', () => {
  // BSE Notice 20150122-30, Annexure 1: "'N' for new record, 'M' for to be modified
  // record and 'D' for to deletion records." The prototype used C, which would have
  // had every cancellation rejected at the exchange.
  const lines = nse.build(BIDS, SETTINGS, {}).text.split('\r\n').filter(Boolean);
  assert.ok(lines[1].endsWith(',N'));
  assert.ok(lines[3].endsWith(',D'), 'a cancelled row is a D action, never C');
  assert.ok(lines[4].endsWith(',M'), 'modified row is an M action');
  assert.ok(lines[4].includes('99001'), 'modify carries the exchange order number');
});

test('a cut-off bid carries the FLOOR PRICE, not zero', () => {
  // Notice 20150122-30 says it twice: Annexure 1, "Please mention floor price when
  // category is RIC"; and 4.3.5, "Margin for bids placed at cut-off price shall be
  // at the floor price". A zero fails the exchange's own at-or-above-floor check,
  // so every retail cut-off row in the file would have come back rejected.
  assert.ok(/RIC,,ASH1002,,100,385,/.test(nse.build(BIDS, SETTINGS, {}).text),
    'default must be the floor price');

  // The escape hatch remains, but has to be asked for explicitly.
  const asZero = Object.assign({}, SETTINGS, { cutoff_price_mode: 'zero' });
  assert.ok(/RIC,,ASH1002,,100,0,/.test(nse.build(BIDS, asZero, {}).text));
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
