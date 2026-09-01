'use strict';
/**
 * Back-office sign-in rules (lib/staffAuth.js). The password comparison and the DB
 * lookups live in routes/staffAuth.js; what is worth pinning here is every decision
 * that could quietly make the direct door weaker than the portal's.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const sa = require('../lib/staffAuth');

test('direct login is on unless it is switched off', () => {
  const prev = process.env.OFS_STAFF_LOGIN;
  delete process.env.OFS_STAFF_LOGIN;
  assert.equal(sa.directLoginEnabled(), true);
  process.env.OFS_STAFF_LOGIN = 'false';
  assert.equal(sa.directLoginEnabled(), false);
  process.env.OFS_STAFF_LOGIN = 'true';
  assert.equal(sa.directLoginEnabled(), true);
  if (prev === undefined) delete process.env.OFS_STAFF_LOGIN; else process.env.OFS_STAFF_LOGIN = prev;
});

test('an unknown, inactive, M365 or password-less account cannot use the password door', () => {
  assert.equal(sa.directLoginBlock(null), 'unknown');
  assert.equal(sa.directLoginBlock({ is_active: false, password_hash: 'x' }), 'inactive');
  assert.equal(sa.directLoginBlock({ use_m365: true, password_hash: 'x' }), 'm365');
  assert.equal(sa.directLoginBlock({ auth_provider: 'm365', password_hash: 'x' }), 'm365');
  assert.equal(sa.directLoginBlock({ password_hash: null }), 'no_password');
  assert.equal(sa.directLoginBlock({ is_active: true, password_hash: '$2b$12$abc' }), null);
});

test('MFA is required when either the account or its role demands it', () => {
  assert.equal(sa.needsMfa({}), false);
  assert.equal(sa.needsMfa({ mfa_enabled: true }), true);
  assert.equal(sa.needsMfa({ requires_mfa: true }), true);
});

test('permissions parse from JSONB or from text', () => {
  assert.deepEqual(sa.pagesOf({ pages: ['ofs-desk'] }), ['ofs-desk']);
  assert.deepEqual(sa.pagesOf('{"pages":["ofs-desk","users"]}'), ['ofs-desk', 'users']);
  assert.deepEqual(sa.pagesOf('not json'), []);
  assert.deepEqual(sa.pagesOf(null), []);
  assert.deepEqual(sa.pagesOf({ pages: 'ofs-desk' }), []);      // not an array: no grant
});

test('SuperAdmin reaches the desk; an unrelated role does not', () => {
  assert.equal(sa.hasDeskGrant({ pages: ['*'] }), true);
  assert.equal(sa.hasDeskGrant({ pages: ['ofs-desk'] }), true);
  assert.equal(sa.hasDeskGrant({ pages: ['ofs-masters'] }), true);
  assert.equal(sa.hasDeskGrant({ pages: ['dashboard', 'users'] }), false);
  assert.equal(sa.hasDeskGrant({ pages: [] }), false);
  assert.equal(sa.hasDeskGrant(null), false);
});

test('a level suffix still counts as a grant, and a lookalike key does not', () => {
  assert.equal(sa.hasDeskGrant({ pages: ['ofs-desk:pii'] }), true);
  assert.equal(sa.hasDeskGrant({ pages: ['ofs-desk:view'] }), true);
  assert.equal(sa.hasDeskGrant({ pages: ['ofs-desk-archive'] }), false);
  assert.equal(sa.hasDeskGrant({ pages: ['ofs'] }), false);
});
