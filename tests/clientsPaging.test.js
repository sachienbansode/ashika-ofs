'use strict';
/**
 * Ten clients a page, on every screen that lists them.
 *
 * The desk's endpoint used to take a `limit` and return that many rows with no
 * offset and no total. So the screen showed the first hundred of tens of
 * thousands, the pager could not be drawn because nothing said how many there
 * were, and the only way to reach client number 101 was to guess a narrower
 * search. The branch endpoint had paged from the start, which is why the front end
 * had forked into two paths — one of which quietly loaded a hundred rows on a
 * phone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the desk list is paged in SQL, with a total', () => {
  const ld = read('db/ldAdapter.js');
  // The signature grew a status filter; the two hard-coded query shapes became
  // one built from whichever narrowings are present, so the LIMIT and OFFSET
  // positions are computed rather than literal.
  assert.match(ld, /async function searchPage\(q, limit, offset, status\)/);
  assert.match(ld, /' LIMIT \$' \+ nL \+ ' OFFSET \$' \+ nO/, 'the list must page');
  assert.match(ld, /pageParams\.push\(lim, off\);/);
  assert.match(ld, /SELECT count\(\*\)::int AS n/);
  // The page and the count must filter identically, or the pager promises rows
  // the list cannot produce. One clause, built once, used by both.
  assert.match(ld, /const MATCH = `upper\(btrim\(u\.ucc\)\) LIKE \$1/);
  assert.match(ld, /const clause = where\.length \? ' WHERE ' \+ where\.join\(' AND '\) : '';/);
  assert.equal((ld.match(/\+ clause/g) || []).length, 2,
    'the page and the count are no longer built from the same clause');
});

test('the page size is bounded, and defaults to ten', () => {
  const ld = read('db/ldAdapter.js');
  assert.match(ld, /Math\.min\(Math\.max\(Number\(limit\) \|\| 10, 1\), 200\)/,
    'an unbounded limit is the whole-table load this change removes');
  assert.match(ld, /Math\.max\(Number\(offset\) \|\| 0, 0\)/, 'a negative offset must not reach SQL');
  assert.match(read('routes/clients.js'),
    /ld\.searchPage\(req\.query\.q, req\.query\.limit \|\| 10,\s*\n?\s*req\.query\.offset, req\.query\.status\)/);
});

test('both endpoints answer in the same shape, so one screen renders both', () => {
  assert.match(read('routes/clients.js'), /total: page\.total, limit: page\.limit, offset: page\.offset/);
  assert.match(read('routes/clientPortal.js'), /clients: withMargin, total, limit, offset/);
});

test('the front end has one paged path, not one per shell', () => {
  const app = read('public/backoffice/app.js');
  assert.match(app, /var CL = \{ offset: 0, limit: 10, q: '', status: '', total: 0 \};/,
    'ten a page, on a phone and on a desk alike');
  // The fork is gone: no branch that asks the desk for a hundred rows.
  assert.ok(!/limit=100/.test(app), 'the desk still asks for a hundred rows');
  assert.match(app, /var qs = '\?limit=' \+ CL\.limit \+ '&offset=' \+ CL\.offset/);
  assert.ok(!/if \(PARTNER\) \{\n\s*var from = CL\.total/.test(app), 'the count line still forks');
});

test('the pager is drawn for both shells', () => {
  const app = read('public/backoffice/app.js');
  const pager = /function renderClientsPager\(\)[\s\S]*?\n}/.exec(app)[0];
  assert.ok(!/!PARTNER/.test(pager), 'the desk was excluded from its own pager');
  assert.match(pager, /if \(CL\.total <= CL\.limit\) \{ el\.innerHTML = ''; return; \}/);
  assert.match(pager, /Page ' \+ page \+ ' of '/);
});

test('narrowing a search while deep in the list does not strand the reader', () => {
  // Page 9 of a search that now has two pages: the server answers with no rows
  // rather than an error, and the screen would show an empty table with a pager
  // saying "Page 9 of 2".
  const app = read('public/backoffice/app.js');
  assert.match(app, /if \(!list\.length && CL\.offset > 0 && CL\.total > 0\) \{/);
  assert.match(app, /CL\.offset = Math\.max\(0, \(Math\.ceil\(CL\.total \/ CL\.limit\) - 1\) \* CL\.limit\);/);
});

test('the old unpaged helper still works for the callers that want a plain list', () => {
  // The bid form's UCC lookup wants "the first few matches", not a page.
  const ld = read('db/ldAdapter.js');
  assert.match(ld, /async function search\(q, limit\) \{[\s\S]{0,200}?searchPage\(q, limit == null \? 50 : limit, 0\)/);
  assert.match(ld, /module\.exports = \{ norm, findByUcc, findMany, search, searchPage/);
});
