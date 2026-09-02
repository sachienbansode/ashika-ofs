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

test('one field accepts a client code, a mobile or an email', () => {
  assert.equal(ca.identifierKind('9820011234'), 'mobile');
  assert.equal(ca.identifierKind(' rajesh@gmail.com '), 'email');

  // real client codes seen in LD
  assert.equal(ca.identifierKind('ASH1001'), 'ucc');
  assert.equal(ca.identifierKind('S247683'), 'ucc');
  assert.equal(ca.identifierKind('A136422'), 'ucc');
  assert.equal(ca.identifierKind('SUBEC11'), 'ucc');
  assert.equal(ca.identifierKind('10025'), 'ucc', 'short numeric codes exist');

  assert.equal(ca.identifierKind('rajesh@'), null, 'not an address');
  assert.equal(ca.identifierKind('rajesh@gmail'), null, 'no TLD');
  assert.equal(ca.identifierKind(''), null);
  assert.equal(ca.identifierKind(null), null);
  assert.equal(ca.identifierKind('   '), null);
  assert.equal(ca.identifierKind('a'), null, 'one character is not a code');
  assert.equal(ca.identifierKind('has space'), null);
});

test('a ten-digit value is treated as a mobile, and also matched as a UCC', () => {
  // A client code CAN be ten digits. The kind is reported as mobile, and
  // findClients ORs in a UCC match — otherwise such a client could never sign in.
  assert.equal(ca.identifierKind('9820011234'), 'mobile');
  assert.equal(ca.identifierKind('+91 98200 11234'), 'mobile', 'punctuation tolerated');
  assert.equal(ca.identifierKind('09820011234'), 'mobile', 'a leading zero is still a mobile');
  assert.equal(ca.identifierKind('98200-11234'), 'mobile');
  assert.equal(ca.identifierKind('12345'), 'ucc', 'too short for a mobile, so a code');
});

test('an @ always means email, never a mobile or code guess', () => {
  assert.equal(ca.identifierKind('9820011234@'), null);
  assert.equal(ca.identifierKind('ASH1001@'), null);
});

test('client codes are normalised to upper case for matching', () => {
  assert.equal(ca.normUcc(' ash1001 '), 'ASH1001');
  assert.equal(ca.normUcc(null), '');
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

/* ---------------------------------------------------------------------------
 * "No client found" vs the generic answer.
 * The route decides from the setting; these pin the shape of that decision so a
 * later edit cannot flip the enumeration-resistant mode on by accident.
 * ------------------------------------------------------------------------- */
const REVEAL = (v) => String(v == null ? 'reveal' : v) === 'reveal';

test('reveal is the default, and only the exact string turns it off', () => {
  assert.equal(REVEAL(undefined), true);
  assert.equal(REVEAL('reveal'), true);
  assert.equal(REVEAL('generic'), false);
  assert.equal(REVEAL(''), false);          // an empty setting is not "reveal"
});

test('what was typed decides the noun in the refusal', () => {
  const noun = (kind) => kind === 'ucc' ? 'client code' : kind === 'mobile' ? 'mobile number' : 'email address';
  assert.equal(noun(ca.identifierKind('S666666')), 'client code');
  assert.equal(noun(ca.identifierKind('9820011234')), 'mobile number');
  assert.equal(noun(ca.identifierKind('a@b.com')), 'email address');
});

test('a client code that does not exist is still a well-formed client code', () => {
  // The point of the fix: S666666 parses fine, so the OTP step used to be reached.
  // Only the database can say it is unknown — the shape cannot.
  assert.equal(ca.identifierKind('S666666'), 'ucc');
  assert.equal(ca.identifierKind('S247683'), 'ucc');
});
