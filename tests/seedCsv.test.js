'use strict';
/**
 * The 2026 seed file is hand-compiled from public reporting, so it gets checked like
 * data, not like documentation: a wrong date or a plausible-but-wrong ISIN in here
 * would end up in the issue master and, worse, in an exchange file.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'docs', 'seed', 'ofs_2026.csv');
const lines = fs.readFileSync(FILE, 'utf8').trim().split(/\r?\n/);
const head = lines.shift().split(',');
const rows = lines.map((l) => {
  const c = l.split(',');
  const o = {};
  head.forEach((h, i) => { o[h] = (c[i] || '').trim(); });
  return o;
});

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

test('every row carries the columns the importer requires', () => {
  const need = ['symbol', 'company', 'isin', 'floor_price', 'hni_open', 'hni_close', 'ret_open', 'ret_close'];
  for (const r of rows) {
    for (const k of need) assert.ok(r[k], 'row ' + r.symbol + ' is missing ' + k);
  }
});

test('an unconfirmed ISIN is an obvious placeholder, never a plausible fake', () => {
  for (const r of rows) {
    const ok = ISIN_RE.test(r.isin) || r.isin === 'ISIN-UNKNOWN';
    assert.ok(ok, r.symbol + ' has neither a valid ISIN nor the placeholder: ' + r.isin);
  }
  // The placeholder must fail the export guard's test — that is what makes it safe.
  assert.equal(ISIN_RE.test('ISIN-UNKNOWN'), false);
});

test('windows are ordered, and retail follows non-retail', () => {
  for (const r of rows) {
    const ho = new Date(r.hni_open), hc = new Date(r.hni_close);
    const ro = new Date(r.ret_open), rc = new Date(r.ret_close);
    for (const [k, d] of [['hni_open', ho], ['hni_close', hc], ['ret_open', ro], ['ret_close', rc]]) {
      assert.ok(!isNaN(d), r.symbol + ' has an unparseable ' + k + ': ' + r[k]);
    }
    assert.ok(hc > ho, r.symbol + ': non-retail window does not close after it opens');
    assert.ok(rc > ro, r.symbol + ': retail window does not close after it opens');
    assert.ok(ro >= hc, r.symbol + ': retail day must follow the non-retail day (T+1)');
  }
});

test('every issue falls inside 2026 up to today', () => {
  for (const r of rows) {
    const y = new Date(r.hni_open).getUTCFullYear();
    assert.equal(y, 2026, r.symbol + ' is not a 2026 issue');
    assert.ok(new Date(r.ret_close) <= new Date('2026-09-02T00:00:00Z'), r.symbol + ' is in the future');
  }
});

test('prices and quantities are sane', () => {
  for (const r of rows) {
    assert.ok(Number(r.floor_price) > 0, r.symbol + ' has no floor price');
    assert.ok(Number(r.cut_price_min) >= Number(r.floor_price) * 0.5,
      r.symbol + ': retail cut-off floor looks wrong against the floor price');
    if (r.issue_qty && r.retail_qty) {
      const share = Number(r.retail_qty) / Number(r.issue_qty);
      // SEBI requires at least 10% reserved for retail.
      assert.ok(share >= 0.099 && share <= 0.35,
        r.symbol + ': retail reservation is ' + (share * 100).toFixed(1) + '%');
    }
  }
});

test('the same scrip may appear more than once, but never twice on one T-day', () => {
  const seen = new Set();
  for (const r of rows) {
    const key = r.symbol.toUpperCase() + '|' + r.isin.toUpperCase() + '|' + r.hni_open.slice(0, 10);
    assert.equal(seen.has(key), false, 'duplicate issue: ' + key);
    seen.add(key);
  }
  assert.equal(rows.length, 27);
});
