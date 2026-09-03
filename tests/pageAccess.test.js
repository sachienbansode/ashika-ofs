'use strict';
/**
 * Page grants.
 *
 * Ashika's rule: whoever has access to OFS has FULL access to OFS. Any grant on any
 * OFS page — bare, ':view', ':edit', ':pii' — confers edit and PII across the whole
 * module. The level machinery is still there and still applies to every non-OFS
 * page, which is why it is tested here too: if OFS ever stops being all-or-nothing,
 * these tests say exactly what changed.
 *
 * The bug this replaced: a bare 'ofs-masters' was VIEW, so an Admin could fill in a
 * whole issue form and be refused on Save with the bare string "read_only".
 */
const test = require('node:test');
const assert = require('node:assert');
const pa = require('../middleware/pageAccess');

const req = (pages) => ({ user: { permissions: { pages } } });
const run = (mw, r) => {
  let called = false, status = 0, body = null;
  mw(r, { status(c) { status = c; return this; }, json(b) { body = b; return this; } }, () => { called = true; });
  return { called, status, body };
};

test('a bare OFS key is full access to the module', () => {
  const r = req(['ofs-masters']);
  assert.equal(pa.levelFor(r, 'ofs-masters'), pa.LEVELS.pii);
  assert.equal(run(pa.requireEdit('ofs-masters'), r).called, true);
  assert.equal(pa.canViewPII(r, 'ofs-masters'), true);
});

test('a grant on ONE OFS page opens the other — the module is granted whole', () => {
  const r = req(['ofs-desk']);
  assert.equal(run(pa.requireEdit('ofs-masters'), r).called, true);
  assert.equal(run(pa.requirePage('ofs-masters'), r).called, true);
});

test("an explicit ':view' on OFS does not mean read-only", () => {
  // Deliberate: there is no half-open OFS user. A desk that may look at the bid
  // book may also generate the file the exchange needs.
  assert.equal(run(pa.requireEdit('ofs-desk'), req(['ofs-desk:view'])).called, true);
});

test('no OFS grant is still refused, and says so', () => {
  const r = run(pa.requireEdit('ofs-masters'), req(['reports:edit']));
  assert.equal(r.called, false);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'read_only', page: 'ofs-masters' });
  assert.equal(pa.canViewPII(req(['reports:edit']), 'ofs-masters'), false);
});

test("'*' is full access, edit and PII alike", () => {
  assert.equal(run(pa.requireEdit('ofs-masters'), req(['*'])).called, true);
  assert.equal(pa.canViewPII(req(['*']), 'ofs-masters'), true);
});

test('OFS access does not leak into a non-OFS page', () => {
  const r = req(['ofs-masters:pii']);
  assert.equal(pa.levelFor(r, 'reports'), 0);
  assert.equal(run(pa.requirePage('reports'), r).status, 403);
});

test('levels still apply to non-OFS pages: bare is view, :edit writes', () => {
  assert.equal(pa.levelFor(req(['reports']), 'reports'), pa.LEVELS.view);
  assert.equal(run(pa.requireEdit('reports'), req(['reports'])).status, 403);
  assert.equal(run(pa.requireEdit('reports'), req(['reports:edit'])).called, true);
  assert.equal(pa.canViewPII(req(['reports:edit']), 'reports'), false);
});

test('an unknown level suffix degrades to view rather than granting more', () => {
  assert.equal(pa.levelFor(req(['reports:admin']), 'reports'), pa.LEVELS.view);
});

test('hasModuleAccess is what the sign-in gate asks', () => {
  assert.equal(pa.hasModuleAccess(req(['ofs-desk:pii'])), true);
  assert.equal(pa.hasModuleAccess(req(['reports', 'users:edit'])), false);
});
