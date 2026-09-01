'use strict';
/**
 * Issue-master normalisation. The network side cannot be tested here, but the part
 * that decides what is safe to write can — and must, because a half-formed issue
 * produces a bad exchange file that is only discovered after the window closes.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { normalise, toDate, pick, num } = require('../lib/issueSource/normalise');
const { changed } = require('../lib/issueDiff');   // pure — no driver needed

test('dates parse in IST across the shapes exchanges use', () => {
  assert.equal(toDate('2026-09-02', '09:15'), '2026-09-02T09:15:00+05:30');
  assert.equal(toDate('02-09-2026', '09:15'), '2026-09-02T09:15:00+05:30');
  assert.equal(toDate('02-Sep-2026', '15:30'), '2026-09-02T15:30:00+05:30');
  assert.equal(toDate('2/9/2026', '9:15'), '2026-09-02T09:15:00+05:30');
  assert.equal(toDate('2026-09-02'), '2026-09-02T09:15:00+05:30', 'defaults to the open');
  assert.equal(toDate('rubbish'), null);
  assert.equal(toDate(''), null);
});

test('the +05:30 offset is explicit, never the server timezone', () => {
  // the server runs UTC; an exchange date read as UTC lands on the wrong day
  assert.ok(toDate('2026-09-02', '09:15').endsWith('+05:30'));
});

test('field lookup ignores case, spaces and punctuation', () => {
  const row = { 'Floor Price': '385.50', 'ISIN No': 'INE522F01014', 'scrip_code': '533278' };
  assert.equal(pick(row, 'floorprice'), '385.50');
  assert.equal(pick(row, 'isin'), 'INE522F01014');
  assert.equal(pick(row, 'scripcode'), '533278');
  assert.equal(pick(row, 'nothing'), null);
});

test('numbers survive currency symbols and commas', () => {
  assert.equal(num('₹ 1,234.50'), 1234.5);
  assert.equal(num('385'), 385);
  assert.equal(num(''), null);
  assert.equal(num('n/a'), null);
});

test('a complete row normalises to an ofs_issue', () => {
  const r = normalise({
    Symbol: 'COALINDIA', CompanyName: 'Coal India Ltd', ISIN: 'INE522F01014',
    FloorPrice: '385.00', ScripCode: '533278', OfferQuantity: '50000000',
    Discount: '5', NonRetailDate: '02-09-2026', RetailDate: '03-09-2026',
    StartTime: '09:15', EndTime: '15:30'
  }, 'BSE');

  assert.equal(r.ok, true);
  assert.equal(r.issue.symbol, 'COALINDIA');
  assert.equal(r.issue.floor_price, 385);
  assert.equal(r.issue.cut_price_min, 385, 'defaults to the floor');
  assert.equal(r.issue.bse_scrip_code, '533278');
  assert.equal(r.issue.issue_qty, 50000000);
  assert.equal(r.issue.discount_pct, 5);
  assert.equal(r.issue.tick, 0.05, 'sensible default');
  assert.equal(r.issue.lot, 1);
  assert.equal(r.issue.source, 'exchange');
  assert.ok(r.issue.hni_open.startsWith('2026-09-02T09:15'));
  assert.ok(r.issue.ret_close.startsWith('2026-09-03T15:30'));
});

test('incomplete rows are rejected with a reason, never written half-formed', () => {
  const base = { Symbol: 'X', ISIN: 'INE000A01001', FloorPrice: '100', BidDate: '02-09-2026' };

  assert.equal(normalise({ ...base, Symbol: '' }, 'BSE').reason, 'no symbol');
  assert.equal(normalise({ ...base, FloorPrice: '' }, 'BSE').reason, 'no floor price');
  assert.equal(normalise({ ...base, FloorPrice: '0' }, 'BSE').reason, 'no floor price');
  assert.equal(normalise({ ...base, ISIN: '' }, 'BSE').reason, 'no ISIN');
  assert.equal(normalise({ ...base, BidDate: '' }, 'BSE').reason, 'no usable non-retail date');
});

test('retail falls back to the non-retail day when only one date is given', () => {
  const r = normalise({ Symbol: 'X', ISIN: 'INE000A01001', FloorPrice: '100',
                        BidDate: '02-09-2026' }, 'BSE');
  assert.equal(r.ok, true);
  assert.ok(r.issue.ret_open.startsWith('2026-09-02'));
});

test('a refresh reports only the fields that actually moved', () => {
  const before = { company: 'Coal India Ltd', floor_price: 385, lot: 1,
                   hni_open: new Date('2026-09-02T09:15:00+05:30'), status: 'Suspended' };
  const next = { company: 'Coal India Ltd', floor_price: 390, lot: 1,
                 hni_open: '2026-09-02T09:15:00+05:30' };

  const diff = changed(before, next);
  assert.deepEqual(diff, ['floor_price'], 'unchanged fields and equal dates are left alone');
  assert.ok(!diff.includes('status'), 'a desk suspension must survive a refresh');
});

test('a field the source did not supply never blanks an existing value', () => {
  const before = { company: 'Coal India Ltd', floor_price: 385, issue_qty: 50000000 };
  assert.deepEqual(changed(before, { floor_price: 385, issue_qty: null }), []);
});
