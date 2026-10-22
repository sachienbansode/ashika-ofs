'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAILER = read('lib', 'mailer.js');
const brand = require('../lib/emailBranding');

/* ---------------------------------------------------------------------------
 * "Password validation is too slow."
 *
 * The password check is one query and one bcrypt compare. What the person was
 * actually waiting on was the sign-in code being mailed before the response
 * returned — and every message was opening a fresh TCP connection, TLS handshake
 * and AUTH exchange with the mail host, after a cross-cloud database round trip
 * just to look up where to send it.
 * ------------------------------------------------------------------------- */

test('the SMTP connection is reused, not rebuilt per message', () => {
  assert.match(MAILER, /pool: true,/);
  assert.match(MAILER, /maxConnections: Number\(process\.env\.SMTP_POOL_MAX \|\| 3\)/);
});

test('a wedged mail host cannot hold a sign-in open', () => {
  for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
    assert.match(MAILER, new RegExp(k + ': Number\\(process\\.env\\.'), k + ' is unbounded');
  }
});

test('the mail settings are not fetched across clouds for every send', () => {
  // getSmtpSettings reads a row from the platform database — on AWS, while this
  // app is on Azure — unless SMTP_HOST is set locally.
  assert.match(MAILER, /async function cachedSmtpSettings\(\)/);
  assert.match(MAILER, /const SETTINGS_TTL_MS = 60000;/);
  assert.match(MAILER, /async function transport\(\) \{\n  const s = await cachedSmtpSettings\(\);/,
    'transport still calls getSmtpSettings directly');
});

/* ------------------------------------------------- and what the mail said -- */

test('an address clients cannot use is caught at boot, not in an inbox', () => {
  // The first live mail carried http://20.244.33.142 — a broken logo and a bare
  // IP in the footer, which is what a phishing mail looks like to a reader and to
  // a spam filter.
  assert.match(brand.appUrlProblem('http://20.244.33.142'), /http, not https/);
  assert.match(brand.appUrlProblem('https://20.244.33.142'), /bare IP address/);
  assert.match(brand.appUrlProblem('http://ofs-bids.ashikagroup.com'), /http, not https/);
  assert.equal(brand.appUrlProblem('https://ofs-bids.ashikagroup.com'), null);
  assert.match(read('server.js'), /\[boot\] email links:/);
});

test('the logo and the footer come from that one address', () => {
  const src = read('lib', 'emailBranding.js');
  assert.match(src, /const logo = process\.env\.BRAND_LOGO_URL \|\| \(url \+ '\/shared\/brand-logo\.png'\)/,
    'so fixing APP_URL fixes the logo too');
});
