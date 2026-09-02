'use strict';
/**
 * /desk -> /backoffice. A 301 is cached hard by browsers, so getting this wrong once
 * strands whoever loads it — worth pinning the edges.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { backofficeRedirect, DESK_RE } = require('../lib/legacyPath');

test('the bare old path lands on the new index', () => {
  assert.equal(backofficeRedirect('/desk'), '/backoffice/');
  assert.equal(backofficeRedirect('/desk/'), '/backoffice/');
});

test('sub-paths are carried across', () => {
  assert.equal(backofficeRedirect('/desk/login.html'), '/backoffice/login.html');
  assert.equal(backofficeRedirect('/desk/app.js'), '/backoffice/app.js');
  assert.equal(backofficeRedirect('/desk/style.css'), '/backoffice/style.css');
});

test('the query string survives — the sign-in page reads ?reason', () => {
  assert.equal(backofficeRedirect('/desk/login.html?reason=superseded'),
    '/backoffice/login.html?reason=superseded');
  assert.equal(backofficeRedirect('/desk?x=1&y=2'), '/backoffice/?x=1&y=2');
});

test('nothing outside the /desk prefix is ever rewritten', () => {
  for (const p of ['/', '/client', '/deskmate', '/deskmate/x', '/api/desk',
                   '/auth/sso', '/backoffice/', '/shared/theme.css']) {
    assert.equal(backofficeRedirect(p), null, p + ' must not redirect');
    assert.equal(DESK_RE.test(p.split('?')[0]), false, p + ' must not match the route');
  }
});

test('the route regex matches exactly what the helper handles', () => {
  for (const p of ['/desk', '/desk/', '/desk/login.html', '/desk/a/b/c']) {
    assert.equal(DESK_RE.test(p), true, p + ' must match');
    assert.ok(backofficeRedirect(p).startsWith('/backoffice/'));
  }
});
