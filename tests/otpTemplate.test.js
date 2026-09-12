'use strict';
/**
 * The one sign-in-code email.
 *
 * This template existed three times — staffAuth, clientAuth, branchAuth — with the
 * same code block and three slightly different security notes. The thing every copy
 * had to get right identically is what teaches a reader to recognise a genuine
 * Ashika code, which is the only defence against someone being talked into reading
 * one down a phone line. A template that exists three times drifts.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { otpEmail, mailCheckEmail, expiryLine } = require('../lib/templates/otp');

test('every door sends the same branded shell', () => {
  for (const audience of ['staff', 'branch', 'client']) {
    const html = otpEmail({ name: 'Test', code: '482913', minutes: 10, audience });
    assert.match(html, /Ashika Group/, audience + ': the header survived');
    assert.match(html, /role="presentation"/, audience + ': table layout, not flexbox');
    assert.match(html, /482913/);
    assert.match(html, /do not reply/i, audience + ': the footer survived');
  }
});

test('the warning is the one thing that legitimately differs', () => {
  // A client who did not ask for a code can ignore it. A member of staff receiving
  // one means their portal password is already in someone else's hands — telling
  // them to "ignore this email" would be advice to ignore a live compromise.
  const staff = otpEmail({ code: '1', minutes: 10, audience: 'staff' });
  const client = otpEmail({ code: '1', minutes: 10, audience: 'client' });
  assert.match(staff, /password may be known to someone else/);
  assert.ok(!/ignore this email/.test(staff));
  assert.match(client, /ignore this email/);
  assert.match(client, /never ask you for it by phone, SMS or email/,
    'the anti-vishing line reaches the people who get phoned');
  assert.match(staff, /BackOffice/);
  assert.match(client, /bidding module/);
});

test('a missing name does not become "Hello null"', () => {
  assert.match(otpEmail({ code: '1', minutes: 5, audience: 'client' }), /Dear Investor,/);
  assert.match(otpEmail({ code: '1', minutes: 5, audience: 'staff' }), /Hello there,/);
  assert.match(otpEmail({ name: null, code: '1', minutes: 5, audience: 'branch' }), /Hello there,/);
});

test('names and codes are escaped, not interpolated raw', () => {
  const html = otpEmail({ name: '<script>alert(1)</script>', code: '<b>9</b>', minutes: 5 });
  assert.ok(!/<script>/.test(html), 'a client name comes from LD and reaches an HTML document');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;9&lt;\/b&gt;/);
});

test('the expiry is a clock time, because a duration goes stale in the inbox', () => {
  // "expires in 10 minutes", read eleven minutes later, is simply wrong. The time
  // is still true whenever it is read, so both are given.
  const at = new Date(Date.now() + 10 * 60000);
  const line = expiryLine(10, at);
  assert.match(line, /valid until <strong>\d{2}:\d{2} (AM|PM) IST<\/strong>/,
    'uppercase AM/PM, like every other time in the product');
  assert.match(line, /about 10 minutes from now/);

  // No expiry, or an unusable one, falls back rather than printing "Invalid Date".
  assert.match(expiryLine(10, null), /expires in <strong>10 minutes<\/strong>/);
  assert.match(expiryLine(10, 'not a date'), /expires in <strong>10 minutes<\/strong>/);
  assert.ok(!/Invalid Date/.test(expiryLine(10, 'not a date')));
  assert.match(expiryLine(1, null), /1 minute<\/strong>/, 'singular');
});

test('the mail check is branded too — it is the sample of what a real one looks like', () => {
  const html = mailCheckEmail({ host: 'app-monitor', source: 'env' });
  assert.match(html, /Ashika Group/);
  assert.match(html, /role="presentation"/);
  assert.match(html, /app-monitor/);
  assert.match(html, /this app's own SMTP settings/);
  assert.match(mailCheckEmail({ source: 'platform' }), /the platform's SMTP settings/);
});

test('no route builds its own copy any more', () => {
  for (const f of ['routes/staffAuth.js', 'routes/clientAuth.js', 'routes/branchAuth.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/function otpEmail\(/.test(src), f + ' still defines its own template');
    assert.match(src, /require\('\.\.\/lib\/templates\/otp'\)/, f + ' uses the shared one');
  }
  // And the mail check no longer sends a bare <p>.
  const chk = fs.readFileSync(path.join(ROOT, 'scripts/check-mail.js'), 'utf8');
  assert.match(chk, /mailCheckEmail\(/);
  assert.ok(!/html: '<p>/.test(chk));
});
