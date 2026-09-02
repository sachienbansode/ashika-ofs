'use strict';
/**
 * BSE response files (Notice 20150122-30, Annexure 1).
 *
 * The detection is the risky part: rejection and allocation are BOTH eleven columns,
 * and reading an allocation as a rejection would mark allotted bids as failed. So
 * the tie-break — a margin flag in the last field versus free text — is pinned here
 * in both directions.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../lib/exchange/bseResponse');

const SUCCESS =
  'COALINDIA,RI,,ASH1001,,500,390.00,2,1000000001,N\r\n' +
  'COALINDIA,RIC,,ASH1002,,100,385.00,2,1000000002,N\r\n';

const REJECTION =
  'COALINDIA,RI,,ASH1003,,300,380.00,2,0,N,Bid price below floor price\r\n';

const ALLOCATION =
  'COALINDIA,RI,,ASH1001,,500,390.00,1000000001,300,388.50,2\r\n' +
  'COALINDIA,RIC,,ASH1002,,100,385.00,1000000002,0,,2\r\n';

const BIDBOOK =
  'COALINDIA,RI,,ASH1001,,500,390.00,1000000001,02-09-2026 09:20:11,02-09-2026 11:02:44,2,N\r\n';

test('a success file yields the Bid Ids — without which modify and cancel cannot work', () => {
  const out = r.parse(SUCCESS);
  assert.equal(out.kind, 'success');
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].bid_id, '1000000001');
  assert.equal(out.rows[0].client_ucc, 'ASH1001');
  assert.equal(out.rows[1].category, 'RIC');
  assert.equal(out.rows[1].price, 385);        // a cut-off bid carries the floor
  assert.equal(out.totals.clients, 2);
});

test('rejection and allocation are both 11 columns and must not be confused', () => {
  const rej = r.parse(REJECTION);
  assert.equal(rej.kind, 'rejection');
  assert.equal(rej.rows[0].error, 'Bid price below floor price');
  assert.equal(rej.totals.errors, 1);

  const alloc = r.parse(ALLOCATION);
  assert.equal(alloc.kind, 'allocation', 'an allocation ends in a margin flag, not text');
  assert.equal(alloc.rows[0].allot_qty, 300);
  assert.equal(alloc.rows[0].allot_price, 388.5);
  assert.equal(alloc.rows[1].allot_qty, 0, 'a bid that got nothing is still a row');
  assert.equal(alloc.totals.allottees, 1);
  assert.equal(alloc.totals.allot_qty, 300);
  assert.equal(Math.round(alloc.totals.allot_value), 116550);
});

test('the bid book download is recognised by its twelve columns', () => {
  const out = r.parse(BIDBOOK);
  assert.equal(out.kind, 'bidbook');
  assert.equal(out.rows[0].bid_id, '1000000001');
  assert.equal(out.rows[0].entered_at, '02-09-2026 09:20:11');
});

test('pipe separated is the same file — members choose either', () => {
  const piped = SUCCESS.replace(/,/g, '|');
  const out = r.parse(piped);
  assert.equal(out.kind, 'success');
  assert.equal(out.rows[0].bid_id, '1000000001');
});

test('a file we do not recognise is refused, never guessed at', () => {
  const out = r.parse('some,random,csv\nwith,three,columns\n');
  assert.equal(out.kind, null);
  assert.match(out.error, /does not match any BSE OFS download layout/);
});

test('a malformed line is reported rather than half-read', () => {
  const out = r.parse(SUCCESS + 'COALINDIA,RI,,,,,,,\r\n');
  assert.equal(out.kind, 'success');
  assert.equal(out.rows.length, 2);
  assert.equal(out.skipped, 1);
});

test('the caller may override detection when they know the file', () => {
  const out = r.parse(ALLOCATION, 'rejection');
  assert.equal(out.kind, 'rejection');   // trusted, even though detection disagrees
});
