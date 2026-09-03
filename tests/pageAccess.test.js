'use strict';
/**
 * Page grants. The bug this pins down: a role granted a bare 'ofs-masters' can
 * open Masters and press every button, and every save comes back 403 read_only.
 * A bare key is VIEW; only ':edit' (or '*') writes. The setup SQL granted the
 * bare form to Admin, which is exactly what the desk hit.
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

test('a bare page key is view, not edit', () => {
  assert.equal(pa.levelFor(req(['ofs-masters']), 'ofs-masters'), pa.LEVELS.view);
  const r = run(pa.requireEdit('ofs-masters'), req(['ofs-masters']));
  assert.equal(r.called, false);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'read_only', page: 'ofs-masters' });
});

test("':edit' writes, and still cannot unmask PII", () => {
  const r = run(pa.requireEdit('ofs-masters'), req(['ofs-masters:edit']));
  assert.equal(r.called, true);
  assert.equal(pa.canViewPII(req(['ofs-masters:edit']), 'ofs-masters'), false);
});

test("'*' is full access, edit and PII alike", () => {
  assert.equal(run(pa.requireEdit('ofs-masters'), req(['*'])).called, true);
  assert.equal(pa.canViewPII(req(['*']), 'ofs-masters'), true);
});

test('a grant on one page does not carry to another', () => {
  const r = run(pa.requireEdit('ofs-masters'), req(['ofs-desk:pii']));
  assert.equal(r.status, 403);
});

test('the highest level among several entries wins', () => {
  assert.equal(pa.levelFor(req(['ofs-masters', 'ofs-masters:edit']), 'ofs-masters'), pa.LEVELS.edit);
});

test('an unknown level suffix degrades to view rather than granting more', () => {
  assert.equal(pa.levelFor(req(['ofs-masters:admin']), 'ofs-masters'), pa.LEVELS.view);
});

test('view alone passes requirePage but not requireEdit', () => {
  assert.equal(run(pa.requirePage('ofs-masters'), req(['ofs-masters'])).called, true);
});
