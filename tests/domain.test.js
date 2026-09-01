'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../lib/domain');
const { ISSUE, T_DAY_11AM, T1_DAY_11AM, ctx } = require('./fixtures');

const errs = (bid, over) => d.validateBid(ISSUE, bid, ctx(over));
const has = (list, re) => list.some((e) => re.test(e));

test('T-day is the Non-Retail window, T+1 is Retail', () => {
  assert.equal(d.catStatus(ISSUE, 'HNI', T_DAY_11AM), 'Open');
  assert.equal(d.catStatus(ISSUE, 'Retail', T_DAY_11AM), 'Upcoming');
  assert.equal(d.catStatus(ISSUE, 'HNI', T1_DAY_11AM), 'Closed');
  assert.equal(d.catStatus(ISSUE, 'Retail', T1_DAY_11AM), 'Open');
});

test('Retail floors at the cut-off price, Non-Retail at the floor price', () => {
  assert.equal(d.minPrice(ISSUE, 'Retail'), 386);
  assert.equal(d.minPrice(ISSUE, 'HNI'), 385);
});

test('desk cut-off is evaluated in IST, not the host timezone', () => {
  assert.equal(d.pastDailyCutoff('15:15', new Date('2026-09-01T11:00:00+05:30')), false);
  assert.equal(d.pastDailyCutoff('15:15', new Date('2026-09-01T15:30:00+05:30')), true);
  // 15:30 IST is 10:00 UTC - a host-local comparison would wrongly pass here
  assert.equal(d.pastDailyCutoff('15:15', new Date('2026-09-01T10:00:00Z')), true);
});

test('a well-formed HNI bid inside its window passes', () => {
  assert.deepEqual(errs({ category: 'HNI', qty: 1000, price: 390, is_cutoff: false }), []);
});

test('price below the floor is rejected', () => {
  assert.ok(has(errs({ category: 'HNI', qty: 1000, price: 380, is_cutoff: false }), /Cannot bid below/));
});

test('off-tick price is rejected', () => {
  assert.ok(has(errs({ category: 'HNI', qty: 1000, price: 390.03, is_cutoff: false }), /tick size/));
});

test('quantity must be a multiple of the lot', () => {
  const issue = Object.assign({}, ISSUE, { lot: 50 });
  assert.ok(d.validateBid(issue, { category: 'HNI', qty: 1010, price: 390, is_cutoff: false }, ctx())
    .some((e) => /multiple of 50/.test(e)));
});

test('HNI bid below the 2 lakh minimum is rejected', () => {
  assert.ok(has(errs({ category: 'HNI', qty: 10, price: 390, is_cutoff: false }), /at least 200000/));
});

test('cut-off bidding is Retail-only', () => {
  assert.ok(has(errs({ category: 'HNI', qty: 1000, is_cutoff: true }), /not available to Non-Retail/));
});

test('Retail application is capped at 2 lakh, counting existing bids in the issue', () => {
  const over = { now: T1_DAY_11AM };
  assert.deepEqual(errs({ category: 'Retail', qty: 500, price: 390, is_cutoff: false }, over), []);
  assert.ok(has(errs({ category: 'Retail', qty: 600, price: 390, is_cutoff: false }, over), /cannot exceed 200000/));
  assert.ok(has(errs({ category: 'Retail', qty: 500, price: 390, is_cutoff: false },
    Object.assign({ usedValueThisIssue: 100000 }, over)), /cannot exceed 200000/));
});

test('a bid outside its category window is rejected', () => {
  assert.ok(has(errs({ category: 'Retail', qty: 100, price: 390, is_cutoff: false }), /is upcoming/));
});

test('margin gates the bid', () => {
  assert.ok(has(errs({ category: 'HNI', qty: 1000, price: 390, is_cutoff: false },
    { availableMargin: 100000 }), /above the free margin/));
  assert.ok(has(errs({ category: 'HNI', qty: 1000, price: 390, is_cutoff: false },
    { availableMargin: 0 }), /margin is 0/));
  // free margin nets off what other live bids already consume
  assert.ok(has(errs({ category: 'HNI', qty: 1000, price: 390, is_cutoff: false },
    { availableMargin: 400000, marginUsed: 300000 }), /above the free margin/));
});

test('only one live bid per scrip per client', () => {
  assert.ok(has(errs({ category: 'HNI', qty: 1000, price: 390, is_cutoff: false },
    { hasLiveBid: true }), /only one bid per scrip/));
  // a modify of that same bid is not a duplicate
  assert.deepEqual(d.validateBid(ISSUE,
    { category: 'HNI', qty: 1000, price: 390, is_cutoff: false, editingId: 7 },
    ctx({ hasLiveBid: true })), []);
});

test('bid value uses the category minimum for a cut-off bid', () => {
  assert.equal(d.bidValue(ISSUE, 'Retail', 100, null, true), 38600);
  assert.equal(d.bidValue(ISSUE, 'HNI', 100, 390, false), 39000);
});

test('an inactive client cannot bid', () => {
  const good = { category: 'HNI', qty: 1000, price: 390, is_cutoff: false, client_ucc: 'ASH2001' };
  // no client context supplied (e.g. a dry-run) => the rule stays silent
  assert.deepEqual(errs(good), []);
  assert.deepEqual(errs(good, { client: { found: true, active: true } }), []);

  const inactive = errs(good, { client: { found: true, active: false, status: 'Closed' } });
  assert.ok(inactive.some((e) => /ASH2001 is not active \(Closed\)/.test(e)), inactive.join(' | '));

  const unknown = errs(good, { client: { found: false, active: false } });
  assert.ok(unknown.some((e) => /No client found/.test(e)));
});

test('an inactive client is refused even when everything else is valid', () => {
  const e = errs({ category: 'HNI', qty: 1000, price: 390, is_cutoff: false },
    { client: { found: true, active: false } });
  assert.equal(e.length, 1, 'exactly one complaint: eligibility');
});

test('a suspended issue accepts nothing', () => {
  const issue = Object.assign({}, ISSUE, { status: 'Suspended' });
  assert.ok(d.validateBid(issue, { category: 'HNI', qty: 1000, price: 390, is_cutoff: false }, ctx())
    .some((e) => /is suspended/.test(e)));
});
