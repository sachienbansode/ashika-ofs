'use strict';
/**
 * Which exchange a bid goes to, and which file carries it.
 *
 * Before ofs_bid.exchange existed there was no answer to either question: the NSE
 * file and the BSE file were each built from every bid. An issue on NSE alone had
 * its bids written into the BSE file, and an issue on BOTH had every bid written
 * into both — so uploading both files submitted the same client twice, once to each
 * exchange, for real money. These are the tests that keep it from coming back.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const d = require('../lib/domain');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the export filters on the exchange, for both preview and download', () => {
  const src = read('routes/export.js');
  assert.match(src, /function exchangeClause/);
  assert.match(src, /upper\(\$\{alias\}\.exchange\) = \$\$\{n\}/);
  // Every caller must pass it. A collect() without the exchange is the old bug.
  const calls = src.match(/collect\(([^)]*)\)/g).filter((c) => !/function/.test(c));
  for (const c of calls) {
    assert.ok(/,/.test(c), 'collect() called without an exchange: ' + c);
  }
});

test('a bid with no exchange is included only where the issue leaves no choice', () => {
  const src = read('routes/export.js');
  // NULL falls back to the ISSUE's exchange — safe when that is NSE or BSE, and
  // deliberately matches nothing when it is BOTH.
  assert.match(src, /exchange IS NULL AND upper\(i\.exchange\) = /);
});

test('bids on a BOTH issue with no exchange are named, not silently dropped', () => {
  const src = read('routes/export.js');
  assert.match(src, /function unroutedBids/);
  assert.match(src, /upper\(i\.exchange\) = 'BOTH'/);
  assert.match(src, /unrouted:/);
});

test('the database refuses BOTH on a bid, and backfills what it can', () => {
  const sql = read('db/migrations/019_bid_exchange.sql');
  assert.match(sql, /exchange IS NULL OR exchange IN \('NSE','BSE'\)/);
  assert.match(sql, /AND i\.exchange IN \('NSE','BSE'\)/);
  // A BOTH issue's existing bids must be left NULL: nobody ever chose for them.
  assert.ok(!/i\.exchange IN \('NSE','BSE','BOTH'\)/.test(sql));
});

test('insert and modify both stamp the exchange', () => {
  const src = read('lib/bidService.js');
  assert.match(src, /const exch = bidExchange\(ctx\.issue, b\.exchange\)/);
  assert.match(src, /branch_code, exchange, qty/);
  assert.match(src, /exchange = \$6/);
});

test('the issue decides where it can; only BOTH asks', () => {
  assert.equal(d.bidExchange({ exchange: 'BSE' }, 'NSE'), 'BSE', 'the issue must win over the request');
  assert.equal(d.bidExchange({ exchange: 'BOTH' }, null), null, 'BOTH must not be guessed');
});

test('the sample CSV covers both single-exchange cases and the BOTH case', () => {
  const csv = read('docs/seed/ofs_test_issues.csv');
  const rows = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  const head = csv.trim().split(/\r?\n/)[0].split(',');
  const col = (r, name) => r[head.indexOf(name)];
  const exchanges = new Set(rows.map((r) => col(r, 'exchange')));
  for (const x of ['NSE', 'BSE', 'BOTH']) assert.ok(exchanges.has(x), 'no ' + x + ' issue to test with');

  // Every BSE-bearing row needs a scrip code, or its BSE file is refused.
  for (const r of rows) {
    if (col(r, 'exchange') !== 'NSE') {
      assert.ok(col(r, 'bse_scrip_code'), col(r, 'symbol') + ' is on BSE with no scrip code');
    }
    assert.equal(r.length, head.length, col(r, 'symbol') + ' has the wrong column count');
    assert.match(col(r, 'isin'), /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, col(r, 'symbol') + ' has a bad ISIN');
  }
});

test('the sample CSV exercises the awkward cases, not just the happy one', () => {
  const csv = read('docs/seed/ofs_test_issues.csv');
  assert.match(csv, /TESTNOFLOOR/,  'no issue with an undisclosed floor');
  assert.match(csv, /TESTNOCUT/,    'no issue with cut-off switched off');
  assert.match(csv, /TESTLOT/,      'no issue with a lot above 1');
  assert.match(csv, /TESTCLOSED/,   'no closed issue to test the dashboard filter');
  assert.match(csv, /TESTFUTURE/,   'no upcoming issue');
  assert.match(csv, /,,0\.05,1,4000000/, 'the undisclosed-floor row should have a blank floor');
});
