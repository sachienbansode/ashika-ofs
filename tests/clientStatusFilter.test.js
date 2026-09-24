'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ld = require('../db/ldAdapter');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP = read('public', 'backoffice', 'app.js');
const HTML = read('public', 'backoffice', 'index.html');
const DESK = read('routes', 'clients.js');
const PORTAL = read('routes', 'clientPortal.js');
const LD = read('db', 'ldAdapter.js');

const fn = (src, name, len) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return src.slice(i, i + (len || 3000));
};

/* ---------------------------------------------------------------------------
 * A status dropdown beside the search box, on a book of 1,36,529 clients paged
 * ten at a time. The whole risk here is where the filtering happens: applied in
 * the browser it would narrow the ten rows already fetched and report every
 * dormant client past page one as not existing.
 * ------------------------------------------------------------------------- */

test('every client falls in exactly one bucket', () => {
  assert.deepEqual(ld.STATUS_BUCKETS, ['active', 'dormant', 'closed', 'inactive']);
  const bucket = (s) => ld.STATUS_BUCKETS.indexOf(String(s).toLowerCase()) >= 0
    ? String(s).toLowerCase() : 'other';
  assert.equal(bucket('Active'), 'active');
  assert.equal(bucket('Dormant'), 'dormant');
  // The blank status is a real row somebody has to be able to reach.
  assert.equal(bucket(''), 'other');
  assert.equal(bucket('Suspended'), 'other');
});

test('a named bucket becomes an equality test on the account status', () => {
  const c = ld.statusClause('Dormant', 4);
  assert.match(c.sql, /lower\(btrim\(COALESCE\(u\.status, ''\)\)\) = \$4/);
  assert.equal(c.param, 'dormant', 'the value reaches SQL as a parameter, not spliced in');
});

test('"other" is everything the named buckets do not claim', () => {
  const c = ld.statusClause('other', 2);
  assert.match(c.sql, /<> ALL\(\$2::text\[\]\)/);
  assert.deepEqual(c.param, ld.STATUS_BUCKETS);
});

test('an unknown or absent filter narrows nothing', () => {
  // A stale bookmark or a hand-typed query string must widen the list, never
  // empty it — an empty screen reads as "you have no clients".
  for (const v of ['', null, undefined, 'all', 'ALL', 'banana', '; DROP TABLE']) {
    assert.equal(ld.statusClause(v, 1), null, JSON.stringify(v) + ' filtered something');
  }
});

test('the filter is applied in SQL, alongside the search, not after it', () => {
  const f = fn(LD, 'searchPage', 3500);
  assert.match(f, /const where = \[\], params = \[\];/,
    'searchPage still has two hard-coded WHERE shapes');
  assert.match(f, /statusClause\(status, params\.length \+ 1\)/,
    'the status clause is not numbered after the search terms');
  // The page and the count have to be built from the same clause or the pager
  // promises a number of rows the list cannot produce.
  assert.match(f, /SELECT \+ clause \+ order \+ ' LIMIT \$' \+ nL \+ ' OFFSET \$' \+ nO/);
  assert.match(f, /'SELECT count\(\*\)::int AS n ' \+ FROM \+ clause/);
});

test('searching and filtering at once is an AND, and the ordering survives', () => {
  const f = fn(LD, 'searchPage', 3500);
  assert.match(f, /where\.join\(' AND '\)/, 'the two narrowings are not combined');
  assert.match(f, /where\.push\('\(' \+ MATCH \+ '\)'\)/,
    'MATCH is an OR chain and is not parenthesised — a status filter would bind to its last branch');
  assert.match(f, /\(upper\(btrim\(u\.ucc\)\) LIKE \$2\) DESC/,
    'the exact-then-prefix ordering was lost in the rewrite');
});

test('both endpoints take the filter and say what they applied', () => {
  assert.match(DESK, /req\.query\.offset, req\.query\.status\)/, 'the desk ignores the filter');
  assert.match(DESK, /status: page\.status,/, 'the desk does not say what it filtered by');
  assert.match(DESK, /statuses: ld\.STATUS_BUCKETS,/);
  assert.match(PORTAL, /const want = String\(req\.query\.status \|\| ''\)\.trim\(\)\.toLowerCase\(\);/,
    'the partner list ignores the filter');
  assert.match(PORTAL, /want === 'other' \? named\.indexOf\(s\) < 0 : s === want/,
    'the partner list buckets differently from the desk');
});

/* ------------------------------------------------------------------- the UI */

test('the dropdown sits before the search box', () => {
  const bar = HTML.slice(HTML.indexOf('id="clStatus"') - 400, HTML.indexOf('id="clGo"'));
  assert.ok(bar.indexOf('id="clStatus"') < bar.indexOf('id="clQ"'),
    'the filter is after the search box');
  for (const v of ['active', 'dormant', 'closed', 'inactive', 'other']) {
    assert.ok(HTML.indexOf('value="' + v + '"') > 0, v + ' is not offered');
  }
  assert.match(HTML, /<option value="">All statuses<\/option>/,
    'there is no way back to the whole book');
});

test('the browser sends the filter rather than applying it', () => {
  const f = fn(APP, 'loadClients', 6000);
  assert.match(f, /CL\.status \? '&status=' \+ encodeURIComponent\(CL\.status\) : ''/,
    'the filter never reaches the server');
  assert.ok(!/clients\.filter\(/.test(f),
    'the page is being filtered in the browser, which only narrows the ten rows fetched');
});

test('changing the filter searches at once', () => {
  assert.match(APP, /bindIf\('#clStatus', 'change', function \(\) \{ loadClients\(true\); \}\);/,
    'the desk has to press Search after picking a status');
  // loadClients(true) resets the offset — filtering while on page nine of an
  // unfiltered list must not ask for page nine of a two-page one.
  assert.match(fn(APP, 'loadClients', 600), /if \(reset\) CL\.offset = 0;/);
});

test('Clear clears both', () => {
  const f = APP.slice(APP.indexOf("bindIf('#clClear'"), APP.indexOf("bindIf('#clClear'") + 400);
  assert.match(f, /\$\('#clQ'\)\.value = '';/);
  assert.match(f, /if \(\$\('#clStatus'\)\) \$\('#clStatus'\)\.value = '';/,
    'a status left set behind a cleared search box reads as half the book vanishing');
});

test('the count line names the filter, so an empty list is never a mystery', () => {
  const f = fn(APP, 'loadClients', 6000);
  assert.match(f, /var lbl = clStatusLabel\(\);/);
  assert.match(f, /CL\.status \? ' · status ' \+ lbl : ''/,
    '"no clients" under a Dormant filter reads as an empty book');
  assert.match(f, /No client has status/, 'the empty table says nothing about the filter');
});

test('a branch is not offered buckets its book cannot hold', () => {
  const f = fn(APP, 'trimStatusMenu', 900);
  assert.match(f, /if \(!el \|\| !PARTNER\) return;/, 'the desk loses options too');
  assert.match(f, /\['closed', 'inactive', 'other'\]/);
  assert.match(APP, /\n  trimStatusMenu\(\);/, 'the trim is never run');
});
