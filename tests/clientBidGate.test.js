'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const CLIENT = read('public', 'client', 'client.js');
const PORTAL = read('routes', 'clientPortal.js');

/* 1. "The Place Bid option becomes active before bid verification in the client
 *    login page. This should behave in line with the Partner/Back Office bid page."
 *
 * The desk's Place bid is disabled until Validate passes. The investor's was live
 * from the moment the card opened, so a bid that had never been checked against
 * the band, the window or the client's margin could be sent and refused only
 * after submission. */
test('Place bid is armed by Check and by nothing else', () => {
  assert.match(CLIENT, /data-bf="submit" disabled/,
    'the button must start disabled, as the desk’s does');
  assert.match(CLIENT, /function setSubmitReady\(box, ok\)/);
  assert.match(CLIENT, /setSubmitReady\(box, r\.ok\);/, 'a passing Check arms it');
  assert.match(CLIENT, /setSubmitReady\(box, false\);\n    if \(e\.status === 401\)/,
    'a Check that errored must not leave it armed');
});

test('a refused bid has to be checked again before it can be sent again', () => {
  const sub = /async function submitBid[\s\S]*?\n\}/.exec(CLIENT)[0];
  assert.ok(!/finally \{ btn\.disabled = false; \}/.test(sub),
    'the reasons a bid was refused — the margin, the window — are what Check tests');
  assert.match(sub, /finally \{[\s\S]*setSubmitReady\(box, false\);/);
});

test('every edit disarms it again', () => {
  // A bid checked at 250 shares and then raised to 500 is not a checked bid, and
  // the free margin the investor was shown is about a bid they are not placing.
  const n = (CLIENT.match(/setSubmitReady\(box, false\);/g) || []).length;
  assert.ok(n >= 5, 'both panes, input and change, and Fill suggested bid — found ' + n);
  assert.match(CLIENT, /setSubmitReady\(box, false\);\n      recalcTotal\(\);/,
    'typing in a figure disarms it');
  assert.match(CLIENT, /fillSuggested\(box\);[\s\S]{0,120}setSubmitReady\(box, false\);/,
    'Fill suggested bid rewrites the figures, so it disarms it too');
});

/* 2. "In client login after placing fresh bid it is not showing in my bid tab."
 *
 * Two causes, and the first took the whole tab with it: /me/bids referenced a
 * settings variable that belongs to a DIFFERENT handler, so every request to it
 * threw a ReferenceError and My bids was empty for everyone, new bid or not. */
test('the bids route fetches its own settings', () => {
  const h = /router\.get\('\/me\/bids'[\s\S]*?\n\}\);/.exec(PORTAL)[0];
  assert.match(h, /bidScope\.decorate\(b, new Date\(\), await settings\.all\(\)\)/);
  assert.ok(!/bidScope\.decorate\(b, new Date\(\), s\)/.test(h),
    'there is no `s` in this handler — reaching for one is a 500 on every load');
});

test('placing or withdrawing a bid reloads My bids', () => {
  // It is a separate list with its own paging and nothing told it; the fifteen
  // second poll that used to paper over this was removed.
  const sub = /async function submitBid[\s\S]*?\n\}/.exec(CLIENT)[0];
  assert.match(sub, /await loadBids\(0\);/, 'a new bid is the newest row, so page one');
  const wd = /async function withdrawBid[\s\S]*?\n\}/.exec(CLIENT)[0];
  assert.match(wd, /await loadBids\(BIDS_PAGE\.offset\);/);
});
