'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const ROUTE = read('routes', 'branchAuth.js');
const CLIENT = read('public', 'client', 'client.js');
const HTML = read('public', 'client', 'index.html');

/* ---------------------------------------------------------------------------
 * "That code has already been used. Please request a new one." — on a screen
 * that had not yet been given a chance to use it.
 *
 * Verifying a code is what spends it: ca.verifyChallenge sets used_at, and it has
 * to, or a code could be replayed. When the address was registered against more
 * than one branch code the route then returned choose_branch and asked the
 * browser to call verify AGAIN with the same code to say which. The second call
 * could only ever answer "used" — so NO address on two branch codes could sign in
 * at all, and requesting a new code simply repeated the loop.
 *
 * The client door has done this correctly from the start: a short-lived chooser
 * ticket, and a /select that takes it. The branch door now does the same.
 * ------------------------------------------------------------------------- */

test('a verified code is never asked for twice', () => {
  const verify = /router\.post\('\/verify'[\s\S]*?\n\}\);/.exec(ROUTE)[0];
  assert.ok(!/branch_codes: candidates \}\);\s*\n\s*\}\s*\n\s*if \(candidates\.indexOf/.test(verify),
    'the old shape: hand back the codes and wait to be called again with the same OTP');
  assert.match(verify, /otp_hash='chooser'|'chooser'/,
    'the chooser ticket is what the browser comes back with');
  assert.match(verify, /const code = candidates\.length === 1 \? candidates\[0\] : null;/,
    'verify must not accept a branch_code from the request body any more');
});

test('the ticket carries the branches it was issued for, and only those', () => {
  const sel = /router\.post\('\/select'[\s\S]*?\n\}\);/.exec(ROUTE)[0];
  assert.match(sel, /otp_hash = 'chooser' AND actor_type = 'branch'/,
    "a client's chooser ticket must not open a branch session");
  assert.match(sel, /expires_at > now\(\)/, 'an abandoned ticket has to go stale');
  assert.match(sel, /row\.branch_codes \|\| \[\]\)\.indexOf\(wanted\) < 0/,
    'the request must not be able to nominate a branch of its own');
});

test('a chosen branch is checked as hard as a sole one', () => {
  // Both doors go through signIn, so a branch closed since the code was sent is
  // refused whether it was the only option or one of two.
  assert.match(ROUTE, /async function signIn\(res, code, email, ip, ua\)/);
  assert.equal((ROUTE.match(/signIn\(res, /g) || []).length, 3, 'verify, select, and the definition');
  assert.match(ROUTE, /const blocked = await branches\.blockedCodes\(\);/);
  // ...and a 403 from it must not surface as a 500.
  assert.equal((ROUTE.match(/if \(e\.status\) return res\.status\(e\.status\)/g) || []).length, 2);
});

/* ------------------------------------------------- and what the screen did -- */

test('the chooser clears the refusal that the spent code left behind', () => {
  const fn = /function showBranchPicker[\s\S]*?\n\}/.exec(CLIENT)[0];
  assert.match(fn, /branchHint\(''\);/,
    'the red sentence from the spent code stayed above the question');
});

test('the chooser does not offer "Send code" underneath itself', () => {
  const fn = /function showBranchPicker[\s\S]*?\n\}/.exec(CLIENT)[0];
  assert.match(fn, /show\(\$\('#brForm'\), false\);/);
  assert.match(HTML, /<div id="brForm">/, 'the ask-for-a-code half has to be hideable');
  // and the hint lives inside that half, so the picker needs its own line
  assert.match(CLIENT, /function pickHint\(msg, bad\)/);
});

test('one click is one sign-in', () => {
  // The handler used to be bound inside the render, so a second pass left two on
  // the list: the first spent the ticket, the second was refused for using it.
  const fn = /function showBranchPicker[\s\S]*?\n\}/.exec(CLIENT)[0];
  assert.ok(!/addEventListener/.test(fn), 'the chooser binds a handler on every render');
  assert.match(CLIENT, /\$\('#brPick'\)\.addEventListener\('click'/, 'bound once, at init');
  assert.match(CLIENT, /btns\.forEach\(function \(b\) \{ b\.disabled = true; \}\);/,
    'a double click must not send two sign-ins');
});

test('two codes one character apart can be told apart', () => {
  // A live address held K005 and KO05 — letter O against digit zero, same firm
  // name on both — and the two buttons were identical on screen.
  assert.match(ROUTE, /function branchCard\(b\)/);
  assert.match(ROUTE, /city: b\.city \|\| null/);
  assert.match(ROUTE, /firm: b\.firm \|\| null/);
  const fn = /function showBranchPicker[\s\S]*?\n\}/.exec(CLIENT)[0];
  assert.match(fn, /class="mono"/, '0 and O are the same shape in the body face');
  assert.match(fn, /b\.city/);
  assert.match(read('db', 'branchAdapter.js'), /async function findMany\(codes\)/,
    'one round trip, not one per code');
});
