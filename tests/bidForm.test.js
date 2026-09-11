'use strict';
/**
 * The bid form's derived values.
 *
 * These rules are duplicated deliberately: the server decides, and the form says
 * the same thing early so a desk is not told at 15:14 what it could have known at
 * 15:09. The duplication is only safe if both say the SAME thing, which is what
 * these tests check against lib/domain.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../lib/domain');

// The form helpers are plain functions in a browser file; lift them out and run
// them rather than re-implementing them here, so this tests the shipped code.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/backoffice/app.js'), 'utf8');
function lift(names) {
  const ctx = { rupee: (n) => '₹' + n, inr: (n) => String(n), Math, Number, String };
  vm.createContext(ctx);
  for (const n of names) {
    const m = new RegExp('function ' + n + '\\([\\s\\S]*?\\n}', 'm').exec(SRC);
    assert.ok(m, 'could not find function ' + n + ' in app.js');
    vm.runInContext(m[0], ctx);
  }
  return ctx;
}
const F = lift(['cutoffAllowed', 'minPriceFor', 'minQtyFor', 'maxRetailQty', 'suggestedBid']);

const ISSUE = { symbol: 'COALINDIA', floor_price: 400, cut_price_min: 395, tick: 0.05, lot: 1, cutoff_flag: true };
const CFG = { retail_cap: 200000, hni_min: 200000 };

test('cut-off is refused for HNI, always', () => {
  assert.equal(F.cutoffAllowed(ISSUE, 'HNI'), false);
  assert.equal(F.cutoffAllowed(ISSUE, 'Retail'), true);
});

test('an issue with cut-off switched off refuses it for retail too', () => {
  assert.equal(F.cutoffAllowed(Object.assign({}, ISSUE, { cutoff_flag: false }), 'Retail'), false);
});

test('the form and the server agree on the minimum price', () => {
  for (const cat of ['Retail', 'HNI']) {
    assert.equal(F.minPriceFor(ISSUE, cat), domain.minPrice(ISSUE, cat),
      'form and lib/domain disagree for ' + cat);
  }
  const noFloor = { floor_price: null, cut_price_min: null, tick: 0.05, lot: 1 };
  assert.equal(F.minPriceFor(noFloor, 'Retail'), domain.minPrice(noFloor, 'Retail'));
});

test('retail minimum is one lot; HNI minimum is what clears the non-retail floor', () => {
  assert.equal(F.minQtyFor(ISSUE, 'Retail', 400, CFG), 1);
  // 2,00,000 / 400 = 500 shares exactly.
  assert.equal(F.minQtyFor(ISSUE, 'HNI', 400, CFG), 500);
});

test('the HNI minimum rounds UP to the lot, never down', () => {
  // Rounding down would produce a bid under the non-retail minimum, which the
  // exchange rejects — the one direction that must never happen.
  const lot50 = Object.assign({}, ISSUE, { lot: 50 });
  const q = F.minQtyFor(lot50, 'HNI', 300, CFG);        // 200000/300 = 666.67 -> 667 -> 700
  assert.equal(q, 700);
  assert.ok(q * 300 >= CFG.hni_min, 'the suggested quantity must clear the minimum');
  assert.equal(q % 50, 0, 'and still be a whole number of lots');
});

test('the largest retail quantity stays under the cap, at the lot', () => {
  assert.equal(F.maxRetailQty(ISSUE, 400, CFG), 500);   // 200000/400
  const lot50 = Object.assign({}, ISSUE, { lot: 50 });
  const q = F.maxRetailQty(lot50, 300, CFG);            // 666 -> 650
  assert.equal(q, 650);
  assert.ok(q * 300 <= CFG.retail_cap, 'the suggestion must not exceed the retail cap');
});

test('the suggested retail bid fits the cap; the suggested HNI bid clears the floor', () => {
  const r = F.suggestedBid(ISSUE, 'Retail', CFG);
  assert.ok(r.qty * r.price <= CFG.retail_cap, 'retail suggestion breaches the ₹2 lakh cap');
  assert.ok(r.price >= domain.minPrice(ISSUE, 'Retail') - 1e-9, 'retail suggestion is below the floor');

  const h = F.suggestedBid(ISSUE, 'HNI', CFG);
  assert.ok(h.qty * h.price >= CFG.hni_min, 'HNI suggestion is under the non-retail minimum');
  assert.equal(h.price, domain.minPrice(ISSUE, 'HNI'), 'HNI should be suggested at the minimum price');
});

test('an issue with no published floor gets no suggestion rather than a made-up one', () => {
  const noFloor = { floor_price: null, cut_price_min: null, tick: 0.05, lot: 1 };
  assert.equal(F.suggestedBid(noFloor, 'Retail', CFG), null);
  assert.equal(F.suggestedBid(noFloor, 'HNI', CFG), null);
});

test('a suggestion always survives the server\'s own validation', () => {
  for (const cat of ['Retail', 'HNI']) {
    const sug = F.suggestedBid(ISSUE, cat, CFG);
    const ctx = { settings: CFG, client: { found: true, active: true },
                  availableMargin: 1e9, marginUsed: 0, usedValueThisIssue: 0, hasLiveBid: false };
    const bid = { client_ucc: 'X', category: cat, qty: sug.qty, price: sug.price, is_cutoff: false };
    const open = Object.assign({}, ISSUE, {
      status: 'Auto',
      hni_open: new Date(Date.now() - 3600e3), hni_close: new Date(Date.now() + 3600e3),
      ret_open: new Date(Date.now() - 3600e3), ret_close: new Date(Date.now() + 3600e3)
    });
    const errs = domain.validateBid(open, bid, ctx)
      .filter((e) => !/market|closed|cut-off of/i.test(e));   // clock-dependent, not the point here
    assert.deepEqual(errs, [], cat + ' suggestion is refused by the server: ' + errs.join(' | '));
  }
});
