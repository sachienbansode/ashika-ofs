'use strict';
/**
 * SSO ticket verification. Redemption itself needs a database, so these cover the
 * pure verification rules — which is where the security properties live.
 */
const { test } = require('node:test');
const assert = require('node:assert');

// Unlike the other suites these need a real signing library, so they are skipped
// before `npm install` rather than failing. They run in CI and on any deployed box.
let jwt, sso;
try {
  jwt = require('jsonwebtoken');
  process.env.OFS_SSO_SECRET = process.env.OFS_SSO_SECRET || 'test-sso-secret-value';
  sso = require('../lib/sso');
} catch (e) {
  test('SSO tests skipped — run npm install first', { skip: true }, () => {});
  return;
}

const SECRET = process.env.OFS_SSO_SECRET;
const now = () => Math.floor(Date.now() / 1000);

function ticket(over, secret) {
  const t = now();
  const claims = Object.assign({
    sub: '42', email: 'desk@ashikagroup.com', sid: 'sid-1', mfa: true,
    typ: 'sso-ticket', jti: 'jti-' + Math.random().toString(36).slice(2),
    iat: t, exp: t + 60
  }, over || {});
  return jwt.sign(claims, secret || SECRET, { audience: sso.AUDIENCE });
}

test('a well-formed ticket verifies', () => {
  const c = sso.verifyTicket(ticket());
  assert.equal(c.sub, '42');
  assert.equal(c.mfa, true);
  assert.equal(c.sid, 'sid-1');
});

test('a ticket signed with the wrong secret is refused', () => {
  assert.throws(() => sso.verifyTicket(ticket({}, 'not-the-secret')),
    (e) => e.code === 'TICKET_INVALID');
});

test('an expired ticket is refused', () => {
  const t = now();
  assert.throws(() => sso.verifyTicket(ticket({ iat: t - 300, exp: t - 60 })),
    (e) => e.code === 'TICKET_EXPIRED');
});

test('a session token cannot be replayed as a ticket', () => {
  // no aud, no typ - exactly what routes/auth.js issues as a session
  const session = jwt.sign({ sub: '42', email: 'x@y.z', role: 'Admin' }, SECRET);
  assert.throws(() => sso.verifyTicket(session), (e) => e.code === 'TICKET_INVALID');
});

test('the wrong audience is refused', () => {
  const t = now();
  const other = jwt.sign({ sub: '42', typ: 'sso-ticket', jti: 'j1', iat: t, exp: t + 60 },
    SECRET, { audience: 'some-other-app' });
  assert.throws(() => sso.verifyTicket(other), (e) => e.code === 'TICKET_INVALID');
});

test('the wrong type is refused even with the right audience', () => {
  assert.throws(() => sso.verifyTicket(ticket({ typ: 'password-reset' })),
    (e) => e.code === 'TICKET_INVALID');
});

test('a ticket with no jti is refused — single-use could not be enforced', () => {
  assert.throws(() => sso.verifyTicket(ticket({ jti: undefined })),
    (e) => e.code === 'TICKET_INVALID');
});

test('a long-lived ticket is refused however it was signed', () => {
  const t = now();
  assert.throws(() => sso.verifyTicket(ticket({ iat: t, exp: t + 3600 })),
    (e) => e.code === 'TICKET_INVALID');
  // ...and one just inside the cap is fine
  assert.ok(sso.verifyTicket(ticket({ iat: t, exp: t + sso.MAX_LIFETIME_S })));
});

test('a missing secret is reported as unconfigured, not as a bad ticket', () => {
  const saved = process.env.OFS_SSO_SECRET;
  delete process.env.OFS_SSO_SECRET;
  try {
    assert.throws(() => sso.verifyTicket('anything'), (e) => e.code === 'SSO_UNCONFIGURED');
  } finally { process.env.OFS_SSO_SECRET = saved; }
});
