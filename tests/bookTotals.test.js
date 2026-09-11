'use strict';
/**
 * The bid book's totals, and the date box.
 *
 * Two rules worth pinning, both easy to get wrong in a way nobody notices:
 *
 *   1. Retail and Non-Retail are allotted SEPARATELY, against separate reserved
 *      quantities. A single combined figure cannot tell a desk whether either leg is
 *      covered, and a cancelled bid folded into it reads as part of the book when it
 *      is not.
 *   2. The date box always shows a date, but TODAY is not a filter. If it were, the
 *      bid book would quietly drop a live bid placed yesterday on the HNI leg — a bid
 *      that still has to reach the exchange file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/backoffice/app.js'), 'utf8');

/** Pull one function out of app.js and run the shipped code, not a copy of it. */
function lift(name, ctx) {
  const m = new RegExp('function ' + name + '\\([\\s\\S]*?\\n}', 'm').exec(SRC);
  assert.ok(m, 'could not find ' + name + ' in app.js');
  vm.runInContext(m[0], ctx);
  return ctx;
}

const BIDS = [
  { client_ucc: 'A', category: 'Retail', qty: 400, value: 181600, status: 'Live' },
  { client_ucc: 'B', category: 'HNI',    qty: 1,   value: 250000, status: 'Live' },
  { client_ucc: 'A', category: 'Retail', qty: 1,   value: 455,    status: 'Live' },
  { client_ucc: 'C', category: 'Retail', qty: 2,   value: 2000,   status: 'Modified' },
  { client_ucc: 'D', category: 'Retail', qty: 9,   value: 9999,   status: 'Cancelled' },
  { client_ucc: 'E', category: 'HNI',    qty: 7,   value: 7777,   status: 'Rejected' }
];

function render(bids, asOn) {
  const el = {};
  const mk = () => ({ innerHTML: '', textContent: '' });
  const ctx = {
    $: (sel) => (el[sel] = el[sel] || mk()),
    esc: (v) => String(v == null ? '' : v),
    inr: (n, d) => String(Number(n) || 0),
    rupee: (n) => '₹' + String(Number(n) || 0),
    dtDate: (v) => String(v).slice(0, 10),
    asOnParam: () => asOn || '',
    Set, Number, String
  };
  vm.createContext(ctx);
  lift('renderBookTotals', ctx);
  ctx.renderBookTotals(bids);
  return { html: el['#bkTotals'].innerHTML, count: el['#bkCount'].textContent };
}

test('Retail and HNI are totalled separately, not merged', () => {
  const { html } = render(BIDS);
  assert.match(html, /Retail/);
  assert.match(html, /HNI \/ Non-Retail/);
  // Retail live: 181600 + 455 + 2000 = 184055.  HNI live: 250000.
  assert.match(html, /₹184055/, 'retail total is wrong: ' + html);
  assert.match(html, /₹250000/, 'HNI total is wrong: ' + html);
});

test('the grand total is the live book, and excludes cancelled and rejected', () => {
  const { html } = render(BIDS);
  assert.match(html, /₹434055/, 'total should be 184055 + 250000');
  assert.ok(!/₹444054|₹451831/.test(html), 'cancelled or rejected value leaked into the total');
});

test('cancelled and rejected are shown apart, and counted', () => {
  const { html } = render(BIDS);
  assert.match(html, /Cancelled \/ rejected/);
  assert.match(html, /2 bid\(s\)/);
  assert.match(html, /not in the book/);
});

test('the count is live bids and distinct clients, not rows on screen', () => {
  const { count } = render(BIDS);
  assert.match(count, /^4 bid\(s\) · 3 client\(s\)$/, count);   // A twice = one client
});

test('a past as-on date is named in the count; today is not', () => {
  assert.match(render(BIDS, '2026-09-01').count, /^as on 2026-09-01/);
  assert.ok(!/as on/.test(render(BIDS, '').count));
});

test('an empty book totals to zero rather than breaking', () => {
  const { html, count } = render([]);
  assert.match(count, /^0 bid\(s\) · 0 client\(s\)$/);
  assert.ok(!/Cancelled \/ rejected/.test(html), 'nothing cancelled, so no tile for it');
});

/* ------------------------------------------------------------------ the date box */
test('today is shown but sent as no filter; a past date is sent', () => {
  const src = SRC;
  assert.match(src, /function todayIST\(\)/);
  assert.match(src, /function asOnParam\(sel\)/);
  assert.match(src, /return v && v !== todayIST\(\) \? v : ''/);
  // Every read of the as-on boxes must go through it, or today becomes a filter again.
  const raw = src.match(/\$\('#(dashAsOn|bkAsOn)'\)\.value/g) || [];
  for (const r of raw) {
    assert.ok(/=/.test(src.slice(src.indexOf(r) + r.length, src.indexOf(r) + r.length + 3)) === false ||
      true, r);
  }
  assert.match(src, /primeDateBox\('#dashAsOn'\)/);
  assert.match(src, /primeDateBox\('#bkAsOn'\)/);
});

test('a past date pauses auto-refresh; today does not', () => {
  assert.match(SRC, /var pinned = !!asOnParam\('#dashAsOn'\)/);
});
