'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sessionTime, SESSION_OPEN, SESSION_CLOSE } = require('../lib/domain');

/* An OFS day runs 09:15 to 15:15 IST. These two defaults are applied wherever a
 * window arrives without a time - the manual form, the CSV import, the API. */

test('the session is 09:15 to 15:15', () => {
  assert.equal(SESSION_OPEN, '09:15');
  assert.equal(SESSION_CLOSE, '15:15');
});

test('a date with no time takes the session time, in IST', () => {
  assert.equal(sessionTime('2026-09-16', 'open'), '2026-09-16T09:15:00+05:30');
  assert.equal(sessionTime('2026-09-16', 'close'), '2026-09-16T15:15:00+05:30');
});

test('midnight means the time was left alone, so it takes the default too', () => {
  assert.equal(sessionTime('2026-09-16T00:00', 'open'), '2026-09-16T09:15:00+05:30');
  assert.equal(sessionTime('2026-09-16T00:00:00', 'close'), '2026-09-16T15:15:00+05:30');
});

/* The heart of it: the desk's browser sends a naive local string with no zone,
 * and a naive timestamp is read by PostgreSQL in the server's zone, which is UTC.
 * 09:15 typed on the desk was stored as 09:15 UTC and read back as 14:45 IST -
 * every window five and a half hours late. */
test('a time the desk typed is stamped as IST, not left naive', () => {
  assert.equal(sessionTime('2026-09-16T09:15', 'open'), '2026-09-16T09:15:00+05:30');
  assert.equal(new Date(sessionTime('2026-09-16T09:15', 'open')).toISOString(),
    '2026-09-16T03:45:00.000Z', 'the instant is not 09:15 in Indian time');
});

test('a time that was deliberately chosen is kept', () => {
  assert.equal(sessionTime('2026-09-16T11:30', 'open'), '2026-09-16T11:30:00+05:30');
  assert.equal(sessionTime('2026-09-16T14:00:30', 'close'), '2026-09-16T14:00:30+05:30');
});

test('a value that already carries a zone is left exactly as it is', () => {
  assert.equal(sessionTime('2026-09-16T09:15:00Z', 'open'), '2026-09-16T09:15:00Z');
  assert.equal(sessionTime('2026-09-16T09:15:00+05:30', 'open'), '2026-09-16T09:15:00+05:30');
});

test('nothing in, nothing out - a date cannot be invented', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(sessionTime(v, 'open'), null);
});

test('a shape we do not recognise is handed on untouched', () => {
  assert.equal(sessionTime('not a date', 'open'), 'not a date');
});

test('a Date object is passed through', () => {
  const d = new Date('2026-09-16T03:45:00Z');
  assert.equal(sessionTime(d, 'open'), d);
});
