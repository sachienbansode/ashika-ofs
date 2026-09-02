'use strict';
/**
 * The rules page is read by clients deciding what to bid, so the two things that
 * must hold are: every claim carries a source, and the two exchanges' genuinely
 * different rules are not quietly merged into one.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', 'rules.js'), 'utf8'), ctx);
const R = ctx.window.OFS_RULES;

test('every shared rule cites a source', () => {
  assert.ok(R.common.length >= 8);
  for (const r of R.common) {
    assert.ok(r.h && r.p, 'a rule needs a heading and a body');
    assert.ok(r.src && r.src.length > 3, 'no citation on: ' + r.h);
  }
});

test('both exchanges are described, each against its own document', () => {
  assert.deepEqual(Object.keys(R.exchanges).sort(), ['BSE', 'NSE']);
  assert.match(R.exchanges.BSE.source, /20150122-30/);
  assert.match(R.exchanges.NSE.source, /WEB API Protocol v1\.3\.0/);
});

test('the cut-off rule is stated differently for each — because it IS different', () => {
  const nse = R.exchanges.NSE.rows.find((r) => /cut-off bid/i.test(r[0]))[1];
  const bse = R.exchanges.BSE.rows.find((r) => /cut-off bid/i.test(r[0]))[1];
  assert.match(nse, /market order/i);
  assert.match(nse, /blank/i);
  assert.match(bse, /RIC/);
  assert.match(bse, /floor price/i);
  assert.notEqual(nse, bse, 'merging these is how a bid gets rejected');
});

test('the inverted margin flag is spelled out on both sides', () => {
  const nse = R.exchanges.NSE.rows.find((r) => /margin/i.test(r[0]))[1];
  const bse = R.exchanges.BSE.rows.find((r) => /margin/i.test(r[0]))[1];
  assert.match(nse, /1 = 100%/);
  assert.match(nse, /0 = 0%/);
  assert.match(bse, /1 = 0%/);
  assert.match(bse, /2 = 100%/);
  assert.match(bse, /reverse of NSE/i, 'the reader must be warned, not left to spot it');
});

test('the page matches what the adapters actually emit', () => {
  const nseAdapter = require('../lib/exchange/nse');
  const bseAdapter = require('../lib/exchange/bse');

  // Series values quoted on the page must be the ones the adapter accepts.
  const seriesRow = R.exchanges.NSE.rows.find((r) => /category is expressed/i.test(r[0]))[1];
  for (const s of nseAdapter.VALID_SERIES) assert.ok(seriesRow.includes(s), 'series ' + s + ' missing');

  // Category codes likewise.
  const catRow = R.exchanges.BSE.rows.find((r) => /category is expressed/i.test(r[0]))[1];
  for (const c of bseAdapter.VALID_CATEGORIES) assert.ok(catRow.includes(c), 'category ' + c + ' missing');
});

test('the ₹2 lakh cap and the retail reservation are both stated', () => {
  const text = R.common.map((r) => r.h + ' ' + r.p).join(' ');
  assert.match(text, /2,00,000|₹2 lakh/);
  assert.match(text, /10%/);
});
