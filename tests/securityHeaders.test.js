'use strict';
/**
 * The response headers a VAPT looks for, and why each one is set the way it is.
 *
 * The HSTS finding was real but the cause was not "we forgot the header": it was
 * tied to an env flag nobody had set, so an app sitting behind an nginx doing TLS
 * perfectly well served its headers as though it were plain HTTP. Tying it to the
 * protocol the request actually arrived on is what stops that recurring after the
 * next deploy to a new box.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('HSTS follows the protocol, not a variable someone has to remember', () => {
  assert.match(SRC, /const HSTS_MAX_AGE = 63072000;/, 'two years');
  assert.match(SRC, /'max-age=' \+ HSTS_MAX_AGE \+ '; includeSubDomains'/);
  // req.secure (trust proxy is on) OR the forwarded header OR the explicit flag.
  assert.match(SRC, /if \(TLS \|\| req\.secure \|\| String\(req\.headers\['x-forwarded-proto'\][^)]*\) === 'https'\)/);
  assert.match(SRC, /app\.set\('trust proxy', 1\);/, 'req.secure is meaningless without it');
  // helmet's own hsts must be off, or it would fight the per-request header.
  assert.match(SRC, /hsts: false,/);
  // preload is a decision about every subdomain of the group, forever, and it is
  // not this app's to make. Checked on the HEADER VALUE, not the file — the comment
  // above it in server.js explains the choice and says the word.
  const header = /'max-age=' \+ HSTS_MAX_AGE \+ '([^']*)'/.exec(SRC);
  assert.ok(header, 'could not find the emitted HSTS value');
  assert.ok(!/preload/.test(header[1]), 'the header must not claim preload');
});

test('Permissions-Policy turns off what this app never uses', () => {
  for (const f of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()']) {
    assert.ok(SRC.includes(f), 'missing ' + f);
  }
  assert.match(SRC, /res\.setHeader\('Permissions-Policy', PERMISSIONS_POLICY\)/);
  // A bidding desk does need to go full screen on a chart; that one is self, not off.
  assert.ok(SRC.includes('fullscreen=(self)'));
});

test('security.txt is configuration, never a guessed mailbox', () => {
  assert.match(SRC, /const SECURITY_CONTACT = String\(process\.env\.SECURITY_CONTACT \|\| ''\)\.trim\(\);/);
  // Unset serves nothing: publishing an address nobody reads is worse than none,
  // because it converts a report into silence.
  assert.match(SRC, /if \(!SECURITY_CONTACT\) return res\.status\(404\)/);
  assert.match(SRC, /'Contact: ' \+ SECURITY_CONTACT/);
  assert.match(SRC, /'Expires: '/, 'RFC 9116 requires an expiry');
});

test('the headers already in place are still in place', () => {
  // The scan confirmed these four; a later edit must not quietly drop one.
  assert.match(SRC, /contentSecurityPolicy: \{/);
  assert.match(SRC, /frameAncestors: \["'none'"\]/);
  assert.match(SRC, /referrerPolicy: \{ policy: 'same-origin' \}/);
  assert.match(SRC, /objectSrc: \["'none'"\]/);
  // helmet sets X-Content-Type-Options: nosniff by default; make sure it is not
  // switched off in the options object.
  assert.ok(!/noSniff: false/.test(SRC));
});
