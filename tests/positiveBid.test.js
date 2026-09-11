'use strict';
/**
 * A bid cannot be negative.
 *
 * The check was `if (!p) e.push('Enter a bid price.')`, which catches zero and blank
 * and lets -5 straight through. On an issue with a published floor the next test —
 * "below the floor" — caught it by accident. On an issue whose floor is NOT published
 * (NSE FAQ v3.0 Q12 says that is normal before the offer opens) there was nothing to
 * compare against: a negative price passed every check, produced a negative order
 * value, and made the margin test pass trivially, because a negative number is below
 * any limit.
 *
 * That combination — the guard that only worked as a side effect of another guard —
 * is why these are pinned separately from the ordinary validation tests.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const d = require('../lib/domain');
const { ISSUE, ctx } = require('./fixtures');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const has = (list, re) => list.some((e) => re.test(e));

const WITH_FLOOR = Object.assign({}, ISSUE, { exchange: 'NSE' });
const NO_FLOOR = Object.assign({}, ISSUE, { exchange: 'NSE', floor_price: null, cut_price_min: null });
const bid = (over) => Object.assign({ exchange: 'NSE', category: 'HNI', qty: 1000, price: 400, is_cutoff: false }, over);

test('a negative price is refused even when NO floor is published', () => {
  // The case that was broken. There is no floor to be "below", so the price itself
  // has to be checked.
  const e = d.validateBid(NO_FLOOR, bid({ price: -5 }), ctx());
  assert.ok(has(e, /positive amount/), e.join(' | '));
});

test('a negative price is refused when a floor IS published', () => {
  const e = d.validateBid(WITH_FLOOR, bid({ price: -5 }), ctx());
  assert.ok(has(e, /positive amount|Cannot bid below/), e.join(' | '));
});

test('zero and blank are still refused, and say so differently', () => {
  assert.ok(has(d.validateBid(NO_FLOOR, bid({ price: 0 }), ctx()), /Enter a bid price/));
  assert.ok(has(d.validateBid(NO_FLOOR, bid({ price: null }), ctx()), /Enter a bid price/));
  assert.ok(has(d.validateBid(NO_FLOOR, bid({ price: '' }), ctx()), /Enter a bid price/));
});

test('a price that is not a number at all is refused', () => {
  for (const p of ['abc', {}, [], NaN, Infinity, -Infinity]) {
    const e = d.validateBid(NO_FLOOR, bid({ price: p }), ctx());
    assert.ok(e.length, 'price ' + String(p) + ' was accepted');
  }
});

test('a negative or zero quantity is refused', () => {
  for (const q of [-10, -1, 0]) {
    assert.ok(has(d.validateBid(NO_FLOOR, bid({ qty: q }), ctx()), /at least/), 'qty ' + q + ' passed');
  }
});

test('a fractional quantity is refused — shares do not come in halves', () => {
  assert.ok(has(d.validateBid(NO_FLOOR, bid({ qty: 10.5 }), ctx()), /whole number/));
});

test('an infinite or nonsense quantity is refused', () => {
  for (const q of [Infinity, NaN, 'abc']) {
    assert.ok(d.validateBid(NO_FLOOR, bid({ qty: q }), ctx()).length, 'qty ' + String(q) + ' passed');
  }
});

test('bidValue never returns a negative, whatever it is handed', () => {
  // A negative order value is not a small bid. It is a bid that should never have
  // been accepted, and it makes every downstream limit pass.
  assert.equal(d.bidValue(NO_FLOOR, 'HNI', 1000, -5, false), 0);
  assert.equal(d.bidValue(NO_FLOOR, 'HNI', -1000, 5, false), 0);
  assert.equal(d.bidValue(NO_FLOOR, 'HNI', 1000, 400, false), 400000);
});

test('a good bid is still accepted — the guard has not become a wall', () => {
  assert.deepEqual(d.validateBid(NO_FLOOR, bid({ price: 400, qty: 1000 }), ctx()), []);
});

test('the database refuses what the application refuses', () => {
  // Verified against PostgreSQL 16; this asserts the migration still says it.
  const sql = read('db/migrations/020_positive_bid.sql');
  assert.match(sql, /price IS NULL OR price > 0/);
  assert.match(sql, /CHECK \(value >= 0\)/);
  assert.match(sql, /available IS NULL OR available >= 0/);
  // qty > 0 has been there since the beginning.
  assert.match(read('db/migrations/001_ofs_schema.sql'), /ofs_bid_qty_ck\s+CHECK \(qty > 0\)/);
});

test('the price inputs refuse a negative before it is typed', () => {
  assert.match(read('public/backoffice/index.html'), /id="pbPrice"[^>]*min="0"/);
  assert.match(read('public/client/client.js'), /type="number" min="0" step=/);
});
