'use strict';
/**
 * "Open" on a past date means open ON that date.
 *
 * The dashboard reported "0 open issues" on a screen headed 11-Sep, above three bids
 * placed on that issue that day. catStatus answers "right now", which is the wrong
 * question once the screen is showing a past date: a window that ran 09:15–15:15 on
 * the 11th is Closed now and was open all day then.
 *
 * A day is a span, not an instant, so this is an overlap test. Getting that wrong in
 * the other direction — a point-in-time check at midnight — would report every issue
 * as closed on every past day.
 */
const test = require('node:test');
const assert = require('node:assert');
const d = require('../lib/domain');

const oneDay = {
  status: 'Auto',
  hni_open: '2026-09-11T09:15:00+05:30', hni_close: '2026-09-11T15:15:00+05:30',
  ret_open: '2026-09-11T09:15:00+05:30', ret_close: '2026-09-11T15:15:00+05:30'
};
const twoDay = {
  status: 'Auto',
  hni_open: '2026-09-11T09:15:00+05:30', hni_close: '2026-09-11T15:15:00+05:30',
  ret_open: '2026-09-12T09:15:00+05:30', ret_close: '2026-09-12T15:15:00+05:30'
};

test('an issue is open on the day its window ran, and on no other', () => {
  assert.equal(d.issueOpenOnDay(oneDay, '2026-09-11'), true);
  assert.equal(d.issueOpenOnDay(oneDay, '2026-09-10'), false);
  assert.equal(d.issueOpenOnDay(oneDay, '2026-09-12'), false);
});

test('a T / T+1 issue is open on BOTH days, in the right category each time', () => {
  assert.equal(d.openOnDay(twoDay, 'HNI', '2026-09-11'), true);
  assert.equal(d.openOnDay(twoDay, 'Retail', '2026-09-11'), false);
  assert.equal(d.openOnDay(twoDay, 'HNI', '2026-09-12'), false);
  assert.equal(d.openOnDay(twoDay, 'Retail', '2026-09-12'), true);
  assert.equal(d.issueOpenOnDay(twoDay, '2026-09-11'), true);
  assert.equal(d.issueOpenOnDay(twoDay, '2026-09-12'), true);
});

test('the day boundary is IST, not UTC', () => {
  // 00:30 IST on the 12th is 19:00 UTC on the 11th. A UTC comparison puts this
  // window on the wrong day entirely.
  const lateNight = Object.assign({}, oneDay, {
    hni_open: '2026-09-12T00:10:00+05:30', hni_close: '2026-09-12T00:50:00+05:30',
    ret_open: '2026-09-12T00:10:00+05:30', ret_close: '2026-09-12T00:50:00+05:30'
  });
  assert.equal(d.issueOpenOnDay(lateNight, '2026-09-12'), true);
  assert.equal(d.issueOpenOnDay(lateNight, '2026-09-11'), false);
});

test('a window touching the very edge of a day still counts', () => {
  const edge = Object.assign({}, oneDay, {
    hni_open: '2026-09-11T23:59:00+05:30', hni_close: '2026-09-12T00:01:00+05:30',
    ret_open: '2026-09-11T23:59:00+05:30', ret_close: '2026-09-12T00:01:00+05:30'
  });
  assert.equal(d.issueOpenOnDay(edge, '2026-09-11'), true);
  assert.equal(d.issueOpenOnDay(edge, '2026-09-12'), true);
});

test('a suspended or closed issue is never open, whatever its windows say', () => {
  for (const st of ['Suspended', 'Closed']) {
    assert.equal(d.issueOpenOnDay(Object.assign({}, oneDay, { status: st }), '2026-09-11'), false, st);
  }
});

test('rubbish in gives false, not a crash or a true', () => {
  assert.equal(d.issueOpenOnDay(oneDay, ''), false);
  assert.equal(d.issueOpenOnDay(oneDay, 'yesterday'), false);
  assert.equal(d.issueOpenOnDay(oneDay, null), false);
  assert.equal(d.issueOpenOnDay({ status: 'Auto' }, '2026-09-11'), false);
});

test('the dashboard only applies it to a PAST date, not to today or all-live', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'routes/dashboard.js'), 'utf8');
  assert.match(src, /const onDay = scope\.all \|\| scope\.date === 'today' \? null : scope\.date/);
  assert.match(src, /open_on_scope: onDay \? issueOpenOnDay\(i, onDay\) : null/);
  // the live statuses must survive alongside it — they are what "can I bid" reads
  assert.match(src, /ret_status: catStatus\(i, 'Retail', now\)/);
});
