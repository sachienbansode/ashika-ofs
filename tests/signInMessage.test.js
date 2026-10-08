'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const ROUTE = read('routes', 'staffAuth.js');
const PAGE = read('public', 'backoffice', 'login.js');

/* ---------------------------------------------------------------------------
 * "Sign-in failed." was the answer to three different questions.
 *
 * Every refusal the route MEANS to give carries a sentence — wrong password, no
 * desk grant, use the portal. The two that did not were the rate limiter, which
 * answers 429 in plain text that the page cannot parse, and the 500, which was a
 * bare error code. Both came out as "Sign-in failed.", the same words a wrong
 * password produces — so a desk locked out by its eleventh attempt, and a desk
 * facing a broken server, both saw a sentence that blamed their password.
 * ------------------------------------------------------------------------- */

test('the rate limiter says it is the rate limiter', () => {
  assert.match(ROUTE, /error: 'too_many_attempts'/);
  assert.match(ROUTE, /const limitHandler = \(req, res\) => res\.status\(429\)\.json\(TOO_MANY\);/,
    'without a handler, express-rate-limit answers in plain text and the page sees nothing');
  for (const l of ['loginLimiter', 'verifyLimiter']) {
    const d = new RegExp('const ' + l + ' = rateLimit\\(\\{[\\s\\S]*?\\}\\);').exec(ROUTE)[0];
    assert.match(d, /handler: limitHandler/, l + ' still answers in plain text');
  }
});

test('a server fault says it is not the password', () => {
  assert.ok(!/status\(500\)\.json\(\{ error: 'server_error' \}\)/.test(ROUTE),
    'a bare code reaches the screen as "Sign-in failed."');
  assert.equal((ROUTE.match(/This is not your password|could not be checked on the server/g) || []).length, 2,
    'both the password step and the code step');
});

test('the page has a sentence for a response nobody wrote one for', () => {
  assert.match(PAGE, /function fallbackFor\(status\)/);
  assert.match(PAGE, /data\.message \|\| fallbackFor\(r\.status\)/);
  // A 429 that was never JSON, a proxy's own 502: the page still has to say something.
  assert.match(PAGE, /status === 429/);
  assert.match(PAGE, /status >= 500/);
});

test('the cap itself is unchanged — this was about the words, not the limit', () => {
  const d = /const loginLimiter = rateLimit\(\{[\s\S]*?\}\);/.exec(ROUTE)[0];
  assert.match(d, /windowMs: 15 \* 60 \* 1000/);
  assert.match(d, /max: 10/);
});
