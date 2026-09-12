'use strict';
/**
 * Every figure on the dashboard describes the same day.
 *
 * The bug: the activity list defaulted to today while the totals and the per-issue
 * aggregates counted every live bid. The screen showed "6 live bids · 711 shares ·
 * ₹6.38 L" directly above a panel reading "No bids yet". Both numbers were real.
 * Neither said which day it meant, so the screen simply could not be trusted.
 *
 * An OFS is a one- or two-day event and the desk starts each morning with a fresh
 * book, so the default is today — with an explicit "all live bids" for the view that
 * matches what the exchange file will actually carry.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SRC = read('routes/dashboard.js');

test('one scope is computed once and used by all three queries', () => {
  // The old shape called asOnClause three times from req, so a change to one
  // could silently miss the others. Now they share a scope.
  assert.match(SRC, /const scope = scopeOf\(req\)/);
  for (const v of ['aggSql', 'totSql', 'recSql']) {
    assert.ok(SRC.includes('const ' + v + ' = asOnClause(scope,'), v + ' does not use the shared scope');
  }
  // Call sites only — the declaration reads `function asOnClause(scope, ...)` and
  // would otherwise be counted as a fourth.
  assert.equal((SRC.match(/[^n] asOnClause\(scope,/g) || []).length, 3,
    'the aggregate, the totals and the recent list must all take the same clause');
});

test('with nothing asked for, the scope is TODAY, not every live bid', () => {
  assert.match(SRC, /return \{ date: \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(d\) \? d : 'today', all: false \}/);
  // and 'today' resolves in SQL rather than being computed in Node, so the server's
  // own clock decides and the three queries cannot drift apart mid-request
  assert.match(SRC, /= \(now\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date/);
});

test('every day comparison is made in IST', () => {
  const casts = SRC.match(/created_at AT TIME ZONE 'Asia\/Kolkata'/g) || [];
  assert.ok(casts.length >= 1, 'no IST cast at all');
  // A bare ::date on a UTC server puts a 00:30 IST bid on the previous day.
  assert.ok(!/\bb?\.?created_at\)::date\s*=\s*now\(\)::date/.test(SRC),
    'a UTC day comparison leaked back in');
});

test('scope=all opts out, and is the view the exchange file matches', () => {
  assert.match(SRC, /String\(q\.scope \|\| ''\) === 'all'/);
  assert.match(SRC, /if \(scope\.all\) return ''/);
});

test('the whole live book is reported alongside, whatever day is shown', () => {
  // So a desk looking at today still knows what a generated file would contain.
  assert.match(SRC, /const allLive = await one\(/);
  assert.match(SRC, /all_live: \{ bids:/);
  assert.match(SRC, /WHERE status = 'Live'`\);/);
});

test('the response says which scope produced it', () => {
  assert.match(SRC, /scope: scope\.all \? 'all' : scope\.date/);
});

test('the screen labels its own figures with that scope', () => {
  const app = read('public/backoffice/app.js');
  assert.match(app, /var scopeWord = d\.scope === 'all'/);
  assert.match(app, /kpiCard\('Bids ' \+ scopeWord/);
  assert.match(app, /kpiCard\('Quantity ' \+ scopeWord/);
  assert.match(app, /kpiCard\('Value ' \+ scopeWord/);
  // and one request carries the scope, rather than each panel deciding for itself
  assert.match(app, /function dashQuery\(\)/);
  assert.equal((app.match(/api\('\/dashboard'/g) || []).length, 1);
});
