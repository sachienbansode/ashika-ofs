'use strict';
/**
 * One-time-code primitives and identity normalisation. No database import, so the
 * rules that matter most — how a code is generated, how it is hashed, when test
 * mode is allowed — are unit-testable without a connection.
 */
const crypto = require('crypto');

const OTP_TTL_MIN = Number(process.env.OFS_OTP_TTL_MIN || 5);
const OTP_MAX_ATTEMPTS = Number(process.env.OFS_OTP_MAX_ATTEMPTS || 5);
const RESEND_COOLDOWN_S = Number(process.env.OFS_OTP_RESEND_S || 60);

/**
 * A fixed code for testing. Refused in production regardless of the flag: a
 * predictable OTP on a live desk would be an open door, not a convenience.
 *
 * This governs the CLIENT-facing codes — client sign-in, branch sign-in, and the
 * confirmation a client gives for a bid placed on their behalf. Those stay on a
 * fixed code until Ashika goes live, because UAT has no real client mailboxes to
 * send to.
 */
function testMode() {
  return String(process.env.OFS_OTP_TEST_MODE || '') === 'true'
      && process.env.NODE_ENV !== 'production';
}

/**
 * Back-office sign-in is different, and deliberately so.
 *
 * Staff addresses are real Ashika mailboxes that exist today, and the back office is
 * the door to every client's PII and to the exchange files. A fixed code on that door
 * in UAT is not a test convenience, it is a shared password. So staff codes are REAL
 * unless someone opts out explicitly — the opposite default from the client side.
 */
function staffTestMode() {
  return String(process.env.OFS_STAFF_OTP_TEST_MODE || '') === 'true'
      && process.env.NODE_ENV !== 'production';
}

function testOtp() { return String(process.env.OFS_OTP_TEST_CODE || '123456'); }

const normMobile = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const normEmail = (v) => String(v || '').trim().toLowerCase();
const hash = (code) => crypto.createHash('sha256').update(String(code).trim()).digest('hex');

/** crypto.randomInt, not Math.random — a guessable code is no protection at all. */
function generateOtp() { return String(crypto.randomInt(100000, 1000000)); }

/** Constant-time compare of two hex digests. */
function hashMatches(givenCode, storedHash) {
  const a = Buffer.from(hash(givenCode), 'utf8');
  const b = Buffer.from(String(storedHash || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Which kind of identifier is this? Sign-in accepts a client code (UCC), a
 * registered mobile, or a registered email — the shape decides how it is matched,
 * and anything that fits none is refused before a query runs.
 *
 * A UCC may itself be ten digits (LD holds codes like '10025' alongside 'ASH1001'),
 * so a ten-digit value is reported as 'mobile' and the lookup ALSO tries it as a
 * UCC. Guessing wrong here would lock a client out of their own account.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UCC_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/]{1,19}$/;

function identifierKind(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return EMAIL_RE.test(raw) ? 'email' : null;

  // People type +91, leading zeros, spaces and dashes. Strip only the punctuation a
  // phone number carries, then see whether ten digits remain.
  const phoneish = raw.replace(/[\s()+\-]/g, '');
  if (/^\d+$/.test(phoneish) && normMobile(phoneish).length === 10) return 'mobile';

  return UCC_RE.test(raw) ? 'ucc' : null;
}

const normUcc = (v) => String(v || '').trim().toUpperCase();

function maskEmail(v) {
  const s = String(v || ''); const i = s.indexOf('@');
  if (i < 1 || i === s.length - 1 || !s.slice(i).includes('.')) return '';
  const keep = i <= 2 ? 1 : 2;
  return s.slice(0, keep) + '•'.repeat(Math.max(2, i - keep)) + s.slice(i);
}
function maskMobile(v) {
  const d = normMobile(v);
  return d.length < 8 ? '' : '••••••' + d.slice(-4);
}

module.exports = {
  OTP_TTL_MIN, OTP_MAX_ATTEMPTS, RESEND_COOLDOWN_S,
  testMode, staffTestMode, testOtp, normMobile, normEmail, hash, hashMatches, generateOtp,
  identifierKind, normUcc, maskEmail, maskMobile
};
