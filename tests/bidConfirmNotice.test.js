'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP = read('public', 'backoffice', 'app.js');
const HTML = read('public', 'backoffice', 'index.html');
const CLIENT = read('public', 'client', 'client.js');
const THEME = read('public', 'shared', 'theme.css');

const fn = (src, name, len) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return src.slice(i, i + (len || 3000));
};

/* ---------------------------------------------------------------------------
 * The confirmation for a placed bid was a banner pinned above the panes, with a
 * Dismiss button and no timer — so it read as part of the page rather than as
 * something that had just happened, and it stayed until somebody cleared it.
 * It is a notification at the bottom now: Close, and it goes on its own.
 * ------------------------------------------------------------------------- */

test('the banner is gone from the markup', () => {
  assert.ok(HTML.indexOf('id="bidDone"') < 0,
    'the pinned banner is still in the page');
  assert.ok(APP.indexOf('bidDoneX') < 0, 'the Dismiss button is still wired up');
  assert.ok(!/>Dismiss</.test(APP), 'something still says Dismiss');
});

test('the confirmation goes through the notification stack', () => {
  const f = fn(APP, 'showBidDone', 2000);
  assert.match(f, /BID_DONE = notify\(\{/, 'the confirmation is not a notification');
  assert.match(f, /kind: 'ok', wide: true, ms: 20000/,
    'the confirmation does not close itself, or closes too soon to read out');
  assert.match(THEME, /\.toast\{position:fixed;right:18px;bottom:18px/,
    'the stack is no longer at the bottom of the screen');
});

test('every notification has a Close button, and it says Close', () => {
  const f = fn(APP, 'notify', 3000);
  assert.match(f, /aria-label="Close"/);
  assert.match(f, /class="tx" type="button"/);
  assert.match(THEME, /\.toast \.tx\{position:absolute/, 'the close button has no styling');
  const c = fn(CLIENT, 'toast', 2500);
  assert.match(c, /aria-label="Close"/, 'the investor portal has no close button');
});

test('the timer stops while the card is being read', () => {
  // The desk reads the reference number back to a client on the phone. A card
  // that clears itself mid-sentence is worse than one that never appeared.
  for (const [name, src, label] of [['notify', APP, 'desk'], ['toast', CLIENT, 'portal']]) {
    const f = fn(src, name, 3000);
    assert.match(f, /addEventListener\('mouseenter', hold\)/, label + ': no pause on hover');
    assert.match(f, /addEventListener\('focusin', hold\)/, label + ': no pause on focus');
    assert.match(f, /addEventListener\('mouseleave', go\)/, label + ': never resumes');
    assert.match(f, /left -= Date\.now\(\) - from;/,
      label + ': resuming restarts the full timer instead of the remainder');
    assert.match(f, /Math\.max\(1500, left\)/,
      label + ': a card can vanish the instant the pointer leaves it');
  }
});

test('the plain toast still works, through the same door', () => {
  assert.match(APP, /function toast\(title, msg, kind\) \{\s*\n\s*return notify\(\{ title: title, msg: msg, kind: kind \}\);/,
    'there are two notification implementations again');
});

test('a modify still clears the previous confirmation', () => {
  const f = fn(APP, 'clearBidDone', 800);
  assert.match(f, /if \(BID_DONE\) \{ BID_DONE\.remove\(\); BID_DONE = null; \}/);
  assert.match(fn(APP, 'startModify', 600), /clearBidDone\(\);/,
    'starting a modify leaves the last confirmation on screen');
});

test('the investor keeps the reference long enough to write it down', () => {
  const f = fn(CLIENT, 'submitBid', 2000);
  assert.match(f, /'ok', 20000\);/, 'the investor gets the default six seconds');
  // And the form still carries the standing condition, which outlives the card.
  assert.match(f, /BID_ACCEPTED_NOTE/, 'the condition is only in the notification now');
});
