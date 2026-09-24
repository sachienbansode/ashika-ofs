'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CLIENT = read('public', 'client', 'client.js');
const HTML = read('public', 'client', 'index.html');
const CSS = read('public', 'client', 'style.css');
const AUTH = read('routes', 'clientAuth.js');
const SETTINGS = read('routes', 'settings.js');

const fn = (src, name, len) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return src.slice(i, i + (len || 3000));
};

/* ---------------------------------------------------------------------------
 * An address that belongs to no client was taken to the code step, and the
 * screen then said nothing at all — an investor who mistypes, or a staff member
 * who uses the client door, waits at a box that will never be filled.
 *
 * The identical answer is NOT the bug. It is the whole point: an unauthenticated
 * caller must not be able to use a sign-in box to enumerate accounts, and the
 * per-identifier throttle cannot cover it because a miss writes no challenge row.
 * What was missing is anything telling the person what to check.
 * ------------------------------------------------------------------------- */

test('the same answer either way is still the default, and still a choice', () => {
  assert.match(AUTH, /const reveal = String\(cfg\.client_login_unknown \|\| 'generic'\) === 'reveal';/,
    'the policy is no longer a setting, or no longer defaults to generic');
  assert.match(AUTH, /If that matches an active account, a code has been sent/,
    'the generic wording changed — it must not hint at whether the account exists');
  // Every success path returns the same object, or the shape itself is the oracle.
  assert.match(AUTH, /Every success path returns exactly this/);
  assert.match(SETTINGS, /client_login_unknown: \{[\s\S]{0,400}choices: \['generic', 'reveal'\]/,
    'the desk can no longer choose');
});

test('the code step says what to check once the cooldown is up', () => {
  assert.match(HTML, /id="otpNoCode"/, 'there is nowhere for the help to go');
  assert.match(CLIENT, /function showNoCodeHelp\(on\)/);
  const f = fn(CLIENT, 'showNoCodeHelp', 2500);
  assert.match(f, /registered on your trading account<\/b>/,
    'it does not say where the code actually goes');
  assert.match(f, /dormant or closed account cannot bid/,
    'an inactive account is the other reason no code arrives, and goes unsaid');
  assert.match(f, /use <b>Branch \/ AP<\/b> above/,
    'somebody signing in with a work address is not pointed at the right door');
});

test('the help is shown to everyone, so it cannot be read as an answer', () => {
  const f = fn(CLIENT, 'showNoCodeHelp', 2500);
  // No branch on whether a code was really sent — that would turn the help panel
  // itself into the oracle the generic answer exists to prevent.
  assert.ok(!/S\.ref/.test(f), 'the panel depends on whether a challenge was created');
  assert.ok(!/sent_to|test_mode|r\.ok/.test(f), 'the panel reads the server’s answer');
  const t = fn(CLIENT, 'tickResend', 700);
  assert.match(t, /showNoCodeHelp\(left <= 0\);/,
    'the panel is not tied to the cooldown, which runs identically either way');
});

test('the branch door does not get it — it names its own failures', () => {
  const f = fn(CLIENT, 'showNoCodeHelp', 2500);
  assert.match(f, /if \(!on \|\| BR\.ref\) \{ el\.classList\.add\('hide'\); return; \}/,
    'the branch door shows client advice, or never hides the panel');
});

test('going back to step 1 takes the panel with it', () => {
  assert.match(fn(CLIENT, 'backToDetails', 700), /showNoCodeHelp\(false\);/,
    'the panel survives into a form that is no longer waiting for anything');
  // …and stays gone. The clock calls tickResend every second, so without this the
  // panel came straight back and sat over a form that is not waiting for a code.
  assert.match(fn(CLIENT, 'showNoCodeHelp', 2500),
    /if \(!pane \|\| pane\.classList\.contains\('hide'\)\) \{ el\.classList\.add\('hide'\); return; \}/,
    'the panel is not tied to the code step being on screen');
});

test('the panel is styled as help, not as an error', () => {
  assert.match(CSS, /\.nocode \{/, 'the panel is unstyled');
  assert.match(HTML, /class="nocode hide" id="otpNoCode" role="status" aria-live="polite"/,
    'it announces itself as an alert, which it is not — nothing has gone wrong yet');
});
