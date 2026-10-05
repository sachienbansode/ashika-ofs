'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP = read('public', 'backoffice', 'app.js');
const CLIENT = read('public', 'client', 'client.js');
const CHTML = read('public', 'client', 'index.html');
const CCSS = read('public', 'client', 'style.css');

const fn = (src, name, len) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return src.slice(i, i + (len || 3000));
};

/* ---------------------------------------------------------------------------
 * The auto-refresh runs every thirty seconds whatever screen the desk is on,
 * and loadDash() does not only paint the dashboard: it replaces STATE.issues
 * and then re-derives the whole bid form from it. A desk part way through a bid
 * had the issue dropdown rebuilt under the cursor, and if the selected offer
 * had dropped out of the biddable list in the meantime the selection went with
 * it — silently, which is how a bid gets filled in against the wrong scrip.
 * ------------------------------------------------------------------------- */

test('the timer still refreshes the dashboard on every tick', () => {
  // The fix must not become "stop refreshing": the KPIs and the book are why
  // the timer exists.
  const f = fn(APP, 'setAutoRefresh', 1200);
  assert.match(f, /STATE\.timer = setInterval\(function \(\) \{\s*\n\s*loadDash\(\);/);
  assert.match(f, /if \(STATE\.tab === 'book'\) loadBook\(\);/);
});

test('a bid in progress is left alone by the refresh', () => {
  assert.match(APP, /function bidFormBusy\(\)/, 'nothing decides whether the form is in use');
  const f = fn(APP, 'loadDash', 2500);
  assert.match(f, /if \(!bidFormBusy\(\)\) \{\s*\n\s*fillIssueSelects\(\);\s*\n\s*refreshBidForm\(\);/,
    'the bid form is still rebuilt unconditionally on every tick');
  // The dashboard itself must NOT be behind that guard.
  assert.ok(f.indexOf('renderDash(d);') < f.indexOf('bidFormBusy()'),
    'the dashboard was put behind the guard too');
  // The filters are not part of the bid, so they stay current either way.
  assert.match(f, /\} else \{[\s\S]{0,200}fillFilterSelects\(\);/);
});

test('busy means editing, touched, or focused — all three', () => {
  const f = fn(APP, 'bidFormBusy', 900);
  assert.match(f, /if \(STATE\.editing\) return true;/, 'a modify in progress is not protected');
  assert.match(f, /if \(PB_DIRTY\) return true;/, 'a half-typed form is not protected');
  // Focus alone counts: replacing the options of a select while its dropdown is
  // open closes it, and neither flag above would catch that.
  assert.match(f, /a\.closest\('#pane-place'\)/, 'an open dropdown is not protected');
});

test('the flag is set by user events only, never by script', () => {
  // Assigning .value from script fires neither change nor input, which is
  // precisely why this flag can be trusted not to latch on a refresh.
  assert.match(APP, /\$\(sel\)\.addEventListener\('change', function \(\) \{ PB_DIRTY = true; refreshBidForm\(\); \}\);/);
  assert.match(APP, /\$\(sel\)\.addEventListener\('input', function \(\) \{ PB_DIRTY = true; refreshBidForm\(\); \}\);/);
  assert.match(APP, /\$\('#pbUcc'\)\.addEventListener\('input', function \(\) \{ PB_DIRTY = true; onUccTyped\(\); \}\);/);
});

test('the flag is cleared whenever the form goes back to empty', () => {
  assert.match(fn(APP, 'clearBidForm', 900), /PB_DIRTY = false;/,
    'the form empties but stays "busy", so the refresh never resumes');
  assert.match(fn(APP, 'endModify', 600), /PB_DIRTY = false;/,
    'ending a modify leaves the refresh frozen');
});

/* ------------------------------------------- not rewriting what has not changed */

test('options are replaced only when they have actually changed', () => {
  const f = fn(APP, 'setOptions', 1200);
  assert.match(f, /if \(el\.innerHTML !== html\) \{/,
    'innerHTML is assigned unconditionally, which closes an open dropdown every tick');
  // And when it IS rebuilt, a selection that no longer exists falls back rather
  // than leaving the select on a value with no option behind it.
  assert.match(f, /el\.options\.length \? el\.options\[0\]\.value : ''/);
  // Re-selecting without a rebuild is still allowed — that is not disruptive.
  assert.match(f, /\} else if \(want != null && el\.value !== want/);
});

test('a selection lost to a closing offer is said out loud', () => {
  const f = fn(APP, 'fillIssueSelects', 4000);
  assert.match(f, /var before = pb\.value;/);
  assert.match(f, /if \(before && pb\.value !== before && !STATE\.editing\)/,
    'the form can still move to another offer without saying so');
  assert.match(f, /That offer closed/);
});

test('CSS.escape guards the option lookup', () => {
  // An issue id is a number today. A selector built by concatenation stops being
  // a selector the moment it is not.
  assert.match(fn(APP, 'setOptions', 1200), /CSS\.escape\(String\(want\)\)/);
});

/* ---------------------------------------------------------------------------
 * "Timer is not applicable to client login at all."
 * ------------------------------------------------------------------------- */

test('the investor portal does not poll', () => {
  assert.ok(!/setInterval\(function \(\) \{ loadIssues\(true\); \}, 15000\)/.test(CLIENT),
    'the fifteen-second poll is back');
  // tickClocks is local arithmetic on a countdown — no server, no rebuild.
  const timers = CLIENT.match(/setInterval\(/g) || [];
  assert.equal(timers.length, 1, 'there is more than one timer: ' + timers.length);
  assert.match(CLIENT, /setInterval\(tickClocks, 1000\)/,
    'the only timer left should be the local clock');
});

test('and the dead timer state went with it', () => {
  assert.match(CLIENT, /var S = \{ ref: null, choose: null, resendAt: 0, tab: 'issues', client: null \};/,
    'S.timer is still there with nothing to set it');
  assert.ok(!/clearInterval\(S\.timer\)/.test(CLIENT), 'a clearInterval for a timer that never starts');
});

test('a Refresh control replaces it, and says when it last read', () => {
  // Without one an investor has no way to see a new offer short of F5.
  assert.match(CHTML, /id="cRefresh"/, 'nothing to refresh with');
  assert.match(CHTML, /id="cRefreshed"/, 'no stamp, so a stale figure looks fresh');
  assert.match(CLIENT, /async function refreshNow\(\)/);
  const f = fn(CLIENT, 'refreshNow', 1200);
  assert.match(f, /await loadIssues\(true\);/);
  assert.match(f, /await loadBids\(0\);/);
  assert.match(f, /stampRefreshed\(\);/);
  // Disabled while it runs, or an impatient double-press is two fetches.
  assert.match(f, /b\.disabled = true;/);
  assert.match(f, /b\.disabled = false;/);
  assert.match(CLIENT, /\$\('#cRefresh'\)\.addEventListener\('click', refreshNow\);/, 'never wired up');
  assert.match(CCSS, /\.refresh \.updated/, 'the stamp is unstyled');
});

test('the first load stamps too, so the control is never blank', () => {
  assert.match(fn(CLIENT, 'enterApp', 1400), /loadIssues\(\)\.then\(stampRefreshed, function \(\) \{\}\);/);
});
