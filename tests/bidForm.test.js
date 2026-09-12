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

// The arithmetic is a browser file shared by all three logins; run the shipped
// file rather than re-implementing it here, so this tests what actually loads.
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SRC = read('public/backoffice/app.js');
const ctx = vm.createContext({ Math, Number, String, isFinite });
ctx.window = ctx;
vm.runInContext(read('public/shared/bidmath.js'), ctx);
// cutoffAllowed is a form rule, not arithmetic, and stays in app.js.
for (const n of ['cutoffAllowed']) {
  const m = new RegExp('function ' + n + '\\([\\s\\S]*?\\n}', 'm').exec(SRC);
  assert.ok(m, 'could not find function ' + n + ' in app.js');
  vm.runInContext(m[0], ctx);
}
const F = Object.assign({ cutoffAllowed: ctx.cutoffAllowed }, ctx.OFS_BIDMATH);

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

/* ---------------------------------------------------------------------------
 * One copy of the arithmetic, and the exchange the form picks for you.
 * ------------------------------------------------------------------------ */

test('all three logins load the same arithmetic, and none keeps a copy', () => {
  // /backoffice and /partner are the same file served twice, so they can never
  // disagree. The client portal is a separate page — this is what keeps it in
  // step, and the check that nobody quietly pastes a second copy back in.
  for (const p of ['public/backoffice/index.html', 'public/client/index.html']) {
    assert.match(read(p), /<script src="\/shared\/bidmath\.js"><\/script>/, p + ' does not load it');
  }
  for (const p of ['public/backoffice/app.js', 'public/client/client.js']) {
    const src = read(p);
    for (const fn of ['minPriceFor', 'minQtyFor', 'maxRetailQty', 'suggestedBid']) {
      assert.ok(!new RegExp('function ' + fn + '\\s*\\(').test(src),
        p + ' has its own ' + fn + ' again — that is the drift this module removed');
    }
  }
});

test('a both-exchange offer defaults to BSE; a single-exchange one cannot be argued with', () => {
  assert.equal(F.defaultExchange({ exchange: 'BOTH' }), 'BSE');
  assert.equal(F.defaultExchange({ exchange: 'both' }), 'BSE');
  assert.equal(F.defaultExchange({ exchange: 'NSE' }), 'NSE', 'an NSE-only offer stays NSE');
  assert.equal(F.defaultExchange({ exchange: 'BSE' }), 'BSE');
  // Nothing to default to, and nothing invented: an issue with no exchange yet.
  assert.equal(F.defaultExchange({ exchange: '' }), '');
  assert.equal(F.defaultExchange(null), '');
});

test('the default the form picks is one the server will accept', () => {
  for (const on of ['BOTH', 'NSE', 'BSE']) {
    const issue = { exchange: on };
    assert.equal(domain.bidExchange(issue, F.defaultExchange(issue)),
      on === 'BOTH' ? 'BSE' : on,
      'the form would offer an exchange the server routes elsewhere');
  }
});

test('the desk form preselects the default instead of leaving "Choose…"', () => {
  // The blank option was the bug: the screen asked for a choice, the person did
  // not notice it, and Validate refused a bid that was otherwise fine.
  assert.match(SRC, /ex\.value = wantedEx === 'NSE' \|\| wantedEx === 'BSE' \? wantedEx : BIDMATH\.defaultExchange\(i\);/);
  assert.ok(!/<option value="">Choose…<\/option>/.test(SRC), 'the blank exchange option is gone');
  // An existing bid's own exchange must still win over the default, or modifying
  // a bid would quietly move it to the other exchange.
  assert.match(SRC, /if \(bid\.exchange\) \$\('#pbExch'\)\.value = bid\.exchange;/);
});

test('a client can fill a suggested bid, and can say which exchange', () => {
  const src = read('public/client/client.js');
  assert.match(src, /data-bf="fill"/, 'no Fill suggested bid button on the client portal');
  assert.match(src, /OFS_BIDMATH\.suggestedBid\(i, g\('cat'\)\.value, SETTINGS\)/);
  assert.match(src, /function exchangeField/);
  // Without this the client's own bid on a both-exchange offer was refused on
  // submit for a choice the screen never offered.
  assert.match(src, /exchange: \/\^\(NSE\|BSE\)\$\/\.test/);
  // And an existing bid's exchange has to come back from the server, or a modify
  // would move it.
  assert.match(read('routes/clientPortal.js'), /is_cutoff, value, status, exchange, created_at/);
});
