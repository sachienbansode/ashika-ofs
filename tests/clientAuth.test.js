'use strict';
/**
 * Client sign-in primitives (lib/otp.js). The database-backed parts — issuing and
 * redeeming a challenge — need a live connection; these cover the rules that decide
 * whether the scheme is sound at all: normalisation, hashing, code generation and
 * the test-mode guard, which is the one that must never misfire.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const ca = require('../lib/otp');   // pure primitives — no driver needed

test('mobile normalises to the last ten digits', () => {
  assert.equal(ca.normMobile('+91 98200 11234'), '9820011234');
  assert.equal(ca.normMobile('09820011234'), '9820011234');
  assert.equal(ca.normMobile('98200-11234'), '9820011234');
  assert.equal(ca.normMobile(''), '');
});

test('email normalises to lowercase and trimmed', () => {
  assert.equal(ca.normEmail('  Rajesh.Agarwal@Gmail.COM '), 'rajesh.agarwal@gmail.com');
});

test('the OTP hash is stable, and is not the code', () => {
  const h = ca.hash('123456');
  assert.equal(h, ca.hash('123456'));
  assert.equal(h, ca.hash(' 123456 '), 'trimmed before hashing');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes('123456'));
  assert.notEqual(ca.hash('123456'), ca.hash('123457'));
});

test('generated codes are six digits and vary', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = ca.generateOtp();
    assert.match(c, /^\d{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 150, 'codes should not repeat in any predictable way');
});

test('test mode is refused in production, whatever the flag says', () => {
  const env = { ...process.env };
  try {
    process.env.OFS_OTP_TEST_MODE = 'true';
    process.env.NODE_ENV = 'production';
    assert.equal(ca.testMode(), false, 'a fixed OTP in production would be a hole, not a convenience');

    process.env.NODE_ENV = 'development';
    assert.equal(ca.testMode(), true);

    process.env.OFS_OTP_TEST_MODE = 'false';
    assert.equal(ca.testMode(), false);

    delete process.env.OFS_OTP_TEST_MODE;
    assert.equal(ca.testMode(), false, 'off unless explicitly enabled');
  } finally {
    process.env = env;
  }
});

test('masking keeps enough to recognise, not enough to reuse', () => {
  const m = ca.maskEmail('rajesh.agarwal@gmail.com');
  assert.ok(m.endsWith('@gmail.com'));
  assert.ok(m.startsWith('ra'));
  assert.ok(!m.includes('jesh'));

  const p = ca.maskMobile('+91 98200 11234');
  assert.ok(p.endsWith('1234'));
  assert.ok(!p.includes('9820'));
});

test('masking copes with junk instead of throwing', () => {
  assert.equal(ca.maskEmail(''), '');
  assert.equal(ca.maskEmail('not-an-email'), '');
  assert.equal(ca.maskMobile('12'), '');
  assert.equal(ca.maskMobile(null), '');
});
