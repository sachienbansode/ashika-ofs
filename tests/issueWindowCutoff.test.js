'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const mh = require('../lib/marketHours');
const d = require('../lib/domain');

/* Bidding runs to the close time on the OFFER, not to one desk-wide cut-off.
 *
 * An offer whose retail leg runs to 17:15 was being refused from 15:15 because of
 * a setting that knows nothing about that offer, and one that shuts at 13:00 was
 * being accepted until 15:15 for the same reason. */

const S = { market_open: '09:15', market_close: '15:30', daily_cutoff: '15:15',
            market_days: '0-6', trading_holidays: '', enforce_margin: '0' };
const at = (utc) => new Date('2026-09-01T' + utc + ':00Z');   // a Tuesday
const IST = (hhmm) => {                                        // IST -> the same instant
  const [h, m] = hhmm.split(':').map(Number);
  const mins = h * 60 + m - (5 * 60 + 30);
  const hh = String(Math.floor((mins + 1440) % 1440 / 60)).padStart(2, '0');
  const mm = String((mins + 1440) % 60).padStart(2, '0');
  return at(hh + ':' + mm);
};

const issue = (openIst, closeIst) => ({
  symbol: 'ABC', isin: 'INE001A01001', exchange: 'BSE', lot: 1, tick: 0.05,
  floor_price: 100, cut_price_min: 100, cutoff_flag: true,
  hni_open: IST(openIst), hni_close: IST(closeIst),
  ret_open: IST(openIst), ret_close: IST(closeIst)
});
const bid = { category: 'Retail', qty: 10, price: 101, is_cutoff: false };
const ctx = { settings: S, availableMargin: 1e7 };
const errs = (i, now) => d.validateBid(i, bid, Object.assign({ now }, ctx));

test('an offer that runs late takes bids after the desk-wide cut-off', () => {
  const late = issue('09:15', '17:15');
  assert.deepEqual(errs(late, IST('16:30')), [],
    'a bid at 16:30 was refused on an offer that closes at 17:15');
  assert.deepEqual(errs(late, IST('17:14')), []);
});

test('an offer that shuts early stops then, not at the desk-wide cut-off', () => {
  const early = issue('09:15', '13:00');
  assert.deepEqual(errs(early, IST('12:59')), []);
  assert.ok(errs(early, IST('13:30')).length,
    'a bid at 13:30 was accepted on an offer that closed at 13:00');
});

test('the refusal names the offer close, not a desk setting', () => {
  const st = mh.marketState(S, IST('17:30'),
    { open: IST('09:15'), close: IST('17:15') });
  assert.equal(st.open, false);
  assert.equal(st.reason, 'after_issue_close');
  assert.equal(st.effectiveClose, '17:15');
  assert.match(mh.closedMessage(st), /closed at 17:15 IST for this offer/);
});

test('before the offer opens is still refused', () => {
  assert.ok(errs(issue('11:00', '15:00'), IST('10:30')).length,
    'a bid before the offer opened was accepted');
});

test('a holiday still shuts the day, whatever the offer says', () => {
  const s = Object.assign({}, S, { trading_holidays: '2026-09-01' });
  const st = mh.marketState(s, IST('11:00'), { open: IST('09:15'), close: IST('17:15') });
  assert.equal(st.open, false);
  assert.equal(st.reason, 'holiday');
});

test('a window that opened yesterday is open from midnight today', () => {
  const ist = mh.istNow(at('06:00'));
  const w = mh.windowToday(ist, new Date('2026-08-31T04:00:00Z'), IST('15:00'));
  assert.equal(w.open, 0, 'a window opened on an earlier day must not gate today');
});

test('a window that closes tomorrow runs to midnight tonight', () => {
  const ist = mh.istNow(at('06:00'));
  const w = mh.windowToday(ist, IST('09:15'), new Date('2026-09-02T09:45:00Z'));
  assert.equal(w.close, 24 * 60);
});

test('with no offer in play the desk-wide setting still decides', () => {
  assert.equal(mh.marketState(S, IST('15:14')).open, true);
  assert.equal(mh.marketState(S, IST('15:16')).open, false);
  assert.equal(mh.marketState(S, IST('15:16')).reason, 'after_cutoff');
});
