'use strict';
/**
 * The trading-session gate (lib/marketHours.js). Every case is built from a UTC
 * instant, because the server runs UTC and the rule is stated in IST — an
 * off-by-5:30 here would silently accept bids after the desk had closed.
 *
 * IST = UTC + 5:30, so 09:45 UTC = 15:15 IST.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const mh = require('../lib/marketHours');

const S = {                       // a normal desk: 09:15–15:30, cut-off 15:15
  market_open: '09:15', market_close: '15:30', daily_cutoff: '15:15',
  market_days: '1-5', trading_holidays: ''
};
// 2026-09-01 is a Tuesday.
const at = (utcHHMM, date) => new Date((date || '2026-09-01') + 'T' + utcHHMM + ':00Z');

test('IST is read from the zone, never from the host clock', () => {
  const ist = mh.istNow(at('09:45'));
  assert.equal(ist.hhmm, '15:15');
  assert.equal(ist.date, '2026-09-01');
  assert.equal(ist.dow, 2);
});

test('open only between the session start and the cut-off', () => {
  assert.equal(mh.marketState(S, at('03:00')).open, false);   // 08:30 IST
  assert.equal(mh.marketState(S, at('03:00')).reason, 'before_open');
  assert.equal(mh.marketState(S, at('04:00')).open, true);    // 09:30 IST
  assert.equal(mh.marketState(S, at('09:44')).open, true);    // 15:14 IST
});

test('the cut-off overrides the market end time', () => {
  // 15:15 IST — the cut-off has arrived, the market has not closed.
  const st = mh.marketState(S, at('09:45'));
  assert.equal(st.open, false);
  assert.equal(st.reason, 'after_cutoff');
  assert.equal(st.effectiveClose, '15:15');
  assert.match(mh.closedMessage(st), /cut-off of 15:15/);
});

test('a cut-off LATER than the close still wins', () => {
  const late = Object.assign({}, S, { daily_cutoff: '15:45' });
  assert.equal(mh.marketState(late, at('09:50')).open, true);        // 15:20 IST
  assert.equal(mh.marketState(late, at('10:14')).open, true);        // 15:44 IST
  assert.equal(mh.marketState(late, at('10:15')).reason, 'after_close'); // 15:45 IST
  assert.equal(mh.marketState(late, at('09:50')).effectiveClose, '15:45');
});

test('with no cut-off set, the market close is the end', () => {
  const none = Object.assign({}, S, { daily_cutoff: '' });
  assert.equal(mh.marketState(none, at('09:45')).open, true);        // 15:15 IST
  assert.equal(mh.marketState(none, at('10:00')).open, false);       // 15:30 IST
  assert.equal(mh.marketState(none, at('10:00')).reason, 'after_close');
});

test('weekends and declared holidays are closed all day', () => {
  // 2026-09-05 is a Saturday.
  const sat = mh.marketState(S, at('06:00', '2026-09-05'));
  assert.equal(sat.open, false);
  assert.equal(sat.reason, 'weekend');

  const hol = Object.assign({}, S, { trading_holidays: '2026-09-01, 2026-10-02' });
  const st = mh.marketState(hol, at('06:00'));
  assert.equal(st.open, false);
  assert.equal(st.reason, 'holiday');
});

test('an IST date change is respected, not the UTC one', () => {
  // 19:00 UTC on 31 Aug is 00:30 IST on 1 Sep — before the open, not after the close.
  const st = mh.marketState(S, at('19:00', '2026-08-31'));
  assert.equal(st.ist.date, '2026-09-01');
  assert.equal(st.reason, 'before_open');
});

test('trading days accept ranges, lists and rubbish', () => {
  assert.deepEqual([...mh.tradingDays('1-5')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...mh.tradingDays('1,3,5')].sort(), [1, 3, 5]);
  assert.deepEqual([...mh.tradingDays('')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...mh.tradingDays('nonsense')].sort(), [1, 2, 3, 4, 5]);
});

test('only well-formed holiday dates count', () => {
  const set = mh.holidaySet('2026-09-01, 1/9/2026, , 2026-10-02');
  assert.equal(set.size, 2);
  assert.equal(set.has('2026-09-01'), true);
  assert.equal(set.has('1/9/2026'), false);
});

test('a bid outside the session is rejected by validateBid', () => {
  const domain = require('../lib/domain');
  const issue = {
    symbol: 'ABC', isin: 'INE001A01001', lot: 1, tick: 0.05,
    floor_price: 100, cut_price_min: 100, cutoff_flag: true,
    hni_open: at('04:00'), hni_close: at('10:00'),
    ret_open: at('04:00'), ret_close: at('10:00')
  };
  const bid = { category: 'Retail', qty: 10, price: 101, is_cutoff: false };
  const ctx = { settings: Object.assign({ enforce_margin: '0' }, S), availableMargin: 1e7 };
  const inSession = domain.validateBid(issue, bid, Object.assign({ now: at('05:00') }, ctx));
  assert.deepEqual(inSession, []);

  const afterCutoff = domain.validateBid(issue, bid, Object.assign({ now: at('09:45') }, ctx));
  assert.ok(afterCutoff.some((m) => /cut-off of 15:15/.test(m)), afterCutoff.join(' | '));
});
