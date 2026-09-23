'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const mh = require('../lib/marketHours');
const d = require('../lib/domain');

/* Who decides when bidding stops.
 *
 * Twice changed, so the rule is written down here rather than inferred. The issue
 * record decides which DAYS an offer runs. The desk cut-off in Settings decides
 * the TIME bidding stops on them. The open time is left exactly as typed.
 *
 * Before: one desk-wide time closed every offer, refusing bids an offer was still
 * open for. Then the offer's own close time decided - and since a new issue
 * defaults to closing at 15:15, nothing the admin set could move it, which is the
 * "looks hardcoded at 3:15" this replaces. */

const S = (cutoff) => ({ market_open: '09:15', market_close: '15:30',
                         daily_cutoff: cutoff, market_days: '0-6',
                         trading_holidays: '', enforce_margin: '0' });
const IST = (hhmm) => new Date('2026-09-01T' + hhmm + ':00+05:30');   // a Tuesday

const issue = (openIst, closeIst) => ({
  symbol: 'ABC', isin: 'INE001A01001', exchange: 'BSE', lot: 1, tick: 0.05,
  floor_price: 100, cut_price_min: 100, cutoff_flag: true,
  hni_open: IST(openIst), hni_close: IST(closeIst),
  ret_open: IST(openIst), ret_close: IST(closeIst)
});
const bid = { category: 'Retail', qty: 10, price: 101, is_cutoff: false };
const errs = (i, now, cutoff) =>
  d.validateBid(i, bid, { settings: S(cutoff), availableMargin: 1e7, now });

test('raising the cut-off lets bidding run past 15:15', () => {
  const i = issue('09:15', '15:15');                 // the default a new issue gets
  assert.ok(errs(i, IST('16:30'), '15:15').length, 'a bid at 16:30 was accepted at a 15:15 cut-off');
  assert.deepEqual(errs(i, IST('16:30'), '18:00'), [],
    'raising the cut-off to 18:00 did not let a bid through at 16:30');
});

test('lowering the cut-off stops the desk early, whatever the offer says', () => {
  const i = issue('09:15', '17:15');
  assert.deepEqual(errs(i, IST('13:30'), '14:00'), []);
  assert.ok(errs(i, IST('14:30'), '14:00').length,
    'a bid at 14:30 was accepted at a 14:00 cut-off');
});

test('the offer still decides which days it runs', () => {
  const i = issue('09:15', '15:15');
  const tomorrow = new Date('2026-09-02T10:00:00+05:30');
  assert.ok(errs(i, tomorrow, '18:00').length, 'a bid was accepted the day after the offer closed');
  const yesterday = new Date('2026-08-31T10:00:00+05:30');
  assert.ok(errs(i, yesterday, '18:00').length, 'a bid was accepted the day before the offer opened');
});

test('the open time is left exactly as it was typed', () => {
  const i = issue('11:00', '15:15');
  assert.ok(errs(i, IST('10:30'), '18:00').length, 'a bid was accepted before the offer opened');
  assert.deepEqual(errs(i, IST('11:30'), '18:00'), []);
});

test('catStatus says Open until the cut-off, not until the typed close', () => {
  const i = issue('09:15', '15:15');
  assert.equal(d.catStatus(i, 'Retail', IST('16:30'), S('18:00')), 'Open');
  assert.equal(d.catStatus(i, 'Retail', IST('16:30'), S('15:15')), 'Closed');
  // With no settings at all it falls back to the time on the issue.
  assert.equal(d.catStatus(i, 'Retail', IST('16:30')), 'Closed');
});

test('effectiveWin keeps the offer day and takes the cut-off hour', () => {
  const w = d.effectiveWin(issue('09:15', '15:15'), 'Retail', S('18:00'));
  assert.equal(w.close.toISOString(), new Date('2026-09-01T18:00:00+05:30').toISOString());
  assert.equal(w.open.toISOString(), IST('09:15').toISOString(), 'the open time moved');
});

test('a holiday still shuts the day, whatever the cut-off is', () => {
  const s = Object.assign(S('18:00'), { trading_holidays: '2026-09-01' });
  const st = mh.marketState(s, IST('11:00'));
  assert.equal(st.open, false);
  assert.equal(st.reason, 'holiday');
});

test('the desk-wide state reads the same setting', () => {
  assert.equal(mh.marketState(S('18:00'), IST('16:30')).open, true);
  assert.equal(mh.marketState(S('15:15'), IST('16:30')).open, false);
  assert.equal(mh.marketState(S('15:15'), IST('16:30')).reason, 'after_cutoff');
});

test('marketState takes no per-issue window any more', () => {
  assert.equal(mh.marketState.length, 2, 'the third argument is back');
  assert.equal(typeof mh.windowToday, 'undefined', 'the per-issue helper is still exported');
});
