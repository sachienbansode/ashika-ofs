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

test('NSE file: action codes N / M / C', () => {
  const lines = nse.build(BIDS, SETTINGS, {}).text.split('\r\n').filter(Boolean);
  assert.ok(lines[1].endsWith(',N'));
  assert.ok(lines[3].endsWith(',C'), 'cancelled row is a C action');
  assert.ok(lines[4].endsWith(',M'), 'modified row is an M action');
  assert.ok(lines[4].includes('99001'), 'modify carries the exchange order number');
});

test('cut-off price is written as 0 by default and as the floor when configured', () => {
  assert.ok(/RIC,,ASH1002,,100,0,/.test(nse.build(BIDS, SETTINGS, {}).text));
  const asFloor = Object.assign({}, SETTINGS, { cutoff_price_mode: 'floor' });
  assert.ok(/RIC,,ASH1002,,100,385,/.test(nse.build(BIDS, asFloor, {}).text));
});

test('exchange files are CRLF and checksummed over the exact bytes', () => {
  const out = nse.build(BIDS, SETTINGS, {});
  assert.ok(out.text.includes('\r\n'));
  assert.ok(/^[0-9a-f]{64}$/.test(out.checksum));
  assert.equal(nse.build(BIDS, SETTINGS, {}).checksum, out.checksum, 'same input, same checksum');
  assert.notEqual(nse.build(BIDS.slice(0, 2), SETTINGS, {}).checksum, out.checksum);
});

test('BSE file: member code, ISIN, cut-off flag, distinct checksum', () => {
  const out = bse.build(BIDS, SETTINGS, { symbol: 'COALINDIA', memberCode: 'ASHIKA01' });
  const lines = out.text.split('\r\n').filter(Boolean);
  assert.equal(lines[0], bse.HEADER.join(','));
  assert.ok(lines[1].startsWith('ASHIKA01,533278,INE522F01014,ASH1001,RI,500,390,N,R1,N'), lines[1]);
  assert.ok(lines[3].includes(',Y,'), 'cut-off is a flag on BSE, not a category');
  assert.notEqual(out.checksum, nse.build(BIDS, SETTINGS, {}).checksum);
});

test('file names carry the exchange and symbol', () => {
  assert.match(nse.fileName('COALINDIA'), /^NSE_OFS_Bid_COALINDIA_\d{8}_\d{4}\.csv$/);
  assert.match(bse.fileName(null), /^BSE_OFS_Bid_ALL_\d{8}_\d{4}\.csv$/);
});

test('a field containing a comma is quoted, not split', () => {
  const bids = [Object.assign({}, BIDS[0], { cp_code: 'A,B' })];
  assert.ok(nse.build(bids, SETTINGS, {}).text.includes('"A,B"'));
});

test('an empty book produces a header-only file with zero rows', () => {
  const out = nse.build([], SETTINGS, {});
  assert.equal(out.rowCount, 0);
  assert.equal(out.totalQty, 0);
  assert.equal(out.text.trim(), nse.HEADER.join(','));
});
