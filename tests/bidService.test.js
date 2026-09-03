'use strict';
/**
 * The pure half of lib/bidService — the shaping every bid goes through before the
 * rules see it. This module exists because the desk and the client must not be able
 * to drift apart; these tests are what say so out loud.
 */
const test = require('node:test');
const assert = require('node:assert');
const bs = require('../lib/bidService');

test('normalise uppercases the UCC and coerces the numbers', () => {
  const b = bs.normalise({ issue_id: '7', client_ucc: ' ash1001 ', category: 'Retail', qty: '100', price: '385.50' });
  assert.equal(b.client_ucc, 'ASH1001');
  assert.equal(b.qty, 100);
  assert.equal(b.price, 385.5);
  assert.equal(b.is_cutoff, false);
});

test('a cut-off bid carries no price, whatever was typed', () => {
  const b = bs.normalise({ is_cutoff: true, price: '999' });
  assert.equal(b.price, null);
  assert.equal(b.is_cutoff, true);
});

test('a client cannot bid on someone else by putting a UCC in the body', () => {
  // This is the shape routes/clientPortal.js builds: the session's UCC is applied
  // last, so whatever arrived in the body is overwritten rather than merged.
  const fromSession = 'ASH1001';
  const b = bs.normalise(Object.assign({}, { client_ucc: 'VICTIM99', qty: 10 }, { client_ucc: fromSession }));
  assert.equal(b.client_ucc, 'ASH1001');
});

test('desk-only fields default to null so a client body cannot smuggle them', () => {
  const b = bs.normalise(Object.assign({}, { cp_code: 'X', custody_code: 'Y', exch_order_no: 'Z' },
    { cp_code: null, custody_code: null, exch_order_no: null }));
  assert.equal(b.cp_code, null);
  assert.equal(b.custody_code, null);
  assert.equal(b.exch_order_no, null);
});

test('mergeForModify keeps what was not sent', () => {
  const before = { id: 3, issue_id: 7, client_ucc: 'ASH1001', category: 'Retail',
                   qty: 100, price: 385, is_cutoff: false };
  const b = bs.mergeForModify(before, { qty: 200 });
  assert.equal(b.qty, 200);
  assert.equal(b.price, 385);
  assert.equal(b.category, 'Retail');
  assert.equal(b.editingId, 3);
});

test('switching a modify to cut-off drops the old price rather than keeping it', () => {
  const before = { id: 3, issue_id: 7, client_ucc: 'A', category: 'Retail', qty: 100, price: 385, is_cutoff: false };
  const b = bs.mergeForModify(before, { is_cutoff: true });
  assert.equal(b.is_cutoff, true);
  assert.equal(b.price, null);
});

test('switching a cut-off bid back to a limit needs a price, and 0 is not one', () => {
  const before = { id: 3, issue_id: 7, client_ucc: 'A', category: 'Retail', qty: 100, price: null, is_cutoff: true };
  const b = bs.mergeForModify(before, { is_cutoff: false });
  assert.equal(b.price, 0);   // validateBid rejects this with "Enter a bid price."
});

test('qty 0 stays 0 rather than becoming the old quantity', () => {
  const before = { id: 3, issue_id: 7, client_ucc: 'A', category: 'Retail', qty: 100, price: 385, is_cutoff: false };
  assert.equal(bs.mergeForModify(before, { qty: 0 }).qty, 0);
});
