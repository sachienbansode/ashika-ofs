'use strict';
/**
 * The client portal's screens, rendered.
 *
 * This exists because of a bug that reached production and could not be caught by
 * anything else we had: removing the branch shell from the client portal left two
 * references to a `branch` variable inside bidBox(). Nothing imports that file,
 * nothing type-checks it, `node --check` parses it happily — a free variable is
 * valid syntax — and every server test passed. The investor saw "Could not load
 * issues / Can't find variable: branch" and an empty screen, because the throw
 * happened while building the markup for an open issue.
 *
 * So: load the WHOLE shipped file into a context with nothing in it but a DOM stub,
 * then actually call the functions that build a screen. A free variable throws a
 * ReferenceError the moment the line runs, which is exactly what we want, and it is
 * the render path — not the network — that these tests walk.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The smallest DOM the file can boot against. Every node records what it was given. */
function stubDom() {
  const made = [];
  function el(id) {
    const node = {
      id: id || '', tagName: 'DIV', value: '', textContent: '', innerHTML: '', disabled: false,
      dataset: {}, style: {}, min: '', step: '',
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on === undefined ? this._s.has(c) : !on) this._s.delete(c); else this._s.add(c); },
        contains(c) { return this._s.has(c); }
      },
      addEventListener() {}, removeEventListener() {}, focus() {}, remove() {},
      querySelector: () => el(), querySelectorAll: () => [],
      closest: () => null, matches: () => false, setAttribute() {}, getAttribute: () => null,
      appendChild() {}, dispatchEvent() {}
    };
    made.push(node);
    return node;
  }
  const doc = {
    // Every lookup answers, so boot() can bind to anything without throwing. This
    // is deliberate: we are hunting free VARIABLES, not missing elements — those
    // have their own test on the back-office side.
    querySelector: (s) => el(String(s).replace(/^#/, '')),
    querySelectorAll: () => [],
    addEventListener() {}, createElement: () => el(),
    body: el('body'), documentElement: el('html')
  };
  return { doc, el, made };
}

function loadClientJs() {
  const { doc, el } = stubDom();
  const ctx = {
    document: doc, console,
    location: { pathname: '/', href: '/', replace() {}, reload() {} },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: async () => { throw new Error('no network in this test'); },
    Intl, Date, Math, Number, String, Object, Array, JSON, RegExp, Error, Set, Map,
    isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    Event: function Event() {}, URLSearchParams,
    navigator: { userAgent: 'test' }, localStorage: undefined
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // The shared arithmetic loads first in the page, so it loads first here.
  vm.runInContext(read('public/shared/bidmath.js'), ctx);
  vm.runInContext(read('public/client/client.js'), ctx);
  return { ctx, el };
}

const OPEN_ISSUE = {
  id: 7, symbol: 'COALINDIA', company: 'Coal India Limited', isin: 'INE522F01014',
  exchange: 'BOTH', floor_price: 400, cut_price_min: 395, min_price_retail: 395,
  tick: 0.05, lot: 1, discount_pct: 5, cutoff_flag: true, status: 'Auto',
  status_label: 'Retail open', ret_status: 'Open', hni_status: 'Closed',
  ret_open: '2026-09-12T04:00:00Z', ret_close: '2026-09-12T09:45:00Z',
  hni_open: '2026-09-11T04:00:00Z', hni_close: '2026-09-11T09:45:00Z',
  my_bid: null
};

test('an open issue renders — the whole card, not just the parts we remembered', () => {
  const { ctx } = loadClientJs();
  ctx.SETTINGS = { retail_cap: 200000, hni_min: 200000 };
  ctx.ISSUES_BY_ID = { 7: OPEN_ISSUE };

  // This is the call that threw in production. It must not throw for ANY of the
  // shapes an investor can be shown.
  const html = ctx.issueCard(OPEN_ISSUE);
  assert.match(html, /COALINDIA/);
  assert.match(html, /data-bid-issue="7"/, 'the bid box is part of the card');
  assert.match(html, /data-bf="fill"/, 'Fill suggested bid is on the client screen');
  assert.match(html, /data-bf="exch"/, 'and the exchange');
  assert.ok(!/undefined/.test(html), 'an undefined leaked into the markup: ' + html.slice(0, 300));
});

test('every state of the bid box renders', () => {
  const { ctx } = loadClientJs();
  const mine = { id: 3, ref: 'OFS-3', category: 'Retail', qty: 500, price: 400, is_cutoff: false,
                 value: 200000, status: 'Live', exchange: 'NSE' };
  const cases = [
    ['no bid, retail only',      OPEN_ISSUE, null, true, false],
    ['an existing bid',          OPEN_ISSUE, mine, true, false],
    ['a cut-off bid',            OPEN_ISSUE, Object.assign({}, mine, { is_cutoff: true, price: null }), true, false],
    ['HNI only',                 Object.assign({}, OPEN_ISSUE, { ret_status: 'Closed', hni_status: 'Open' }), null, false, true],
    ['both categories open',     Object.assign({}, OPEN_ISSUE, { hni_status: 'Open' }), null, true, true],
    ['nothing open',             Object.assign({}, OPEN_ISSUE, { ret_status: 'Closed', hni_status: 'Closed' }), null, false, false],
    ['no floor published',       Object.assign({}, OPEN_ISSUE, { floor_price: null, cut_price_min: null }), null, true, false]
  ];
  for (const [name, issue, bid, ret, hni] of cases) {
    assert.doesNotThrow(() => ctx.bidBox(issue, bid, ret, hni), name + ' threw');
  }
  // The withdraw button belongs to a client who HAS a bid, and to nobody else.
  assert.match(ctx.bidBox(OPEN_ISSUE, mine, true, false), /data-bf="cancel"/);
  assert.ok(!/data-bf="cancel"/.test(ctx.bidBox(OPEN_ISSUE, null, true, false)));
});

test('the exchange field offers a choice only where there is one', () => {
  const { ctx } = loadClientJs();
  assert.match(ctx.exchangeField({ exchange: 'BOTH' }, null), /<select/);
  assert.match(ctx.exchangeField({ exchange: 'BOTH' }, null), /value="BSE" selected/,
    'a both-exchange offer defaults to BSE');
  // An existing bid keeps its own exchange, or modifying it would move it.
  assert.match(ctx.exchangeField({ exchange: 'BOTH' }, { exchange: 'NSE' }), /value="NSE" selected/);
  const one = ctx.exchangeField({ exchange: 'NSE' }, null);
  assert.match(one, /readonly/, 'a single-exchange offer is not a choice');
  assert.ok(!/<select/.test(one));
});

test('margin renders for a client and for a branch, including the bad cases', () => {
  const { ctx } = loadClientJs();
  const shapes = [
    { scope: 'client', ucc: 'S247683', available: 500000, used: 200000, free: 300000, at: '2026-09-12T03:30:00Z', live_bids: 1 },
    { scope: 'client', available: 0, used: 0, free: 0, at: null, live_bids: 0 },
    { scope: 'client', available: 100000, used: 200000, free: -100000, at: '2026-09-12T03:30:00Z', live_bids: 2 },
    { scope: 'book', clients: 121, available: 9e6, used: 4e6, free: 5e6, short: 3, with_bids: 12 },
    { scope: 'book', clients: 0, available: 0, used: 0, free: 0, short: 0, with_bids: 0 }
  ];
  for (const m of shapes) {
    assert.doesNotThrow(() => ctx.renderMargin(m, m.scope === 'book'), JSON.stringify(m) + ' threw');
  }
  // No margin at all must hide the card rather than render three dashes.
  assert.doesNotThrow(() => ctx.renderMargin(null, false));
});

test('no stray globals survive in the shipped file', () => {
  const src = read('public/client/client.js');
  // The specific leftover that shipped. `branch` is a local inside loadBids and a
  // parameter of renderMargin; anywhere else it is the bug coming back.
  const lines = src.split('\n');
  const bad = [];
  let inLoadBids = false, inRenderMargin = false;
  lines.forEach((l, n) => {
    if (/^async function loadBids\(/.test(l)) inLoadBids = true;
    else if (/^function renderMargin\(/.test(l)) inRenderMargin = true;
    else if (/^(async )?function /.test(l)) { inLoadBids = false; inRenderMargin = false; }
    if (inLoadBids || inRenderMargin) return;
    const code = l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/(^|[^.\w'"])branch\s*(\?|\)|&&|\|\||===|!==)/.test(code)) bad.push((n + 1) + ': ' + l.trim());
  });
  assert.deepEqual(bad, [], 'branch is used outside the two functions that declare it');
});
