'use strict';
/**
 * The phone.
 *
 * The zoom the desk reported is not a zoom setting — it is iOS Safari zooming the
 * page in when a form control smaller than 16px takes focus, and never zooming
 * back out. Tap Quantity on the bid form and the page jumps to about 130% with the
 * Validate button off the side of the screen. It reads as a broken layout, and the
 * natural reaction is to pinch it back, which is why it looks like a zoom problem.
 *
 * Locking the viewport does not fix it: iOS has ignored user-scalable=no and
 * maximum-scale since iOS 10, precisely because sites used them this way, and on
 * Android it takes pinch-zoom away from people who need it to read. The font size
 * is the fix. These tests keep both halves of that true.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGES = ['public/backoffice/index.html', 'public/client/index.html',
               'public/backoffice/login.html'];

test('every page tells the browser about the notch and the keyboard', () => {
  for (const p of PAGES) {
    const m = /<meta name="viewport" content="([^"]+)">/.exec(read(p));
    assert.ok(m, p + ' has no viewport meta');
    assert.match(m[1], /width=device-width/);
    assert.match(m[1], /initial-scale=1/);
    assert.match(m[1], /viewport-fit=cover/, p + ': content runs under the notch');
    assert.match(m[1], /interactive-widget=resizes-content/,
      p + ': the on-screen keyboard covers the field being typed into');
  }
});

test('pinch-zoom is left alone — the auto-zoom is fixed at the source', () => {
  for (const p of PAGES) {
    const src = read(p);
    assert.ok(!/user-scalable\s*=\s*no/.test(src), p + ' blocks pinch-zoom');
    assert.ok(!/maximum-scale\s*=\s*1/.test(src), p + ' pins maximum-scale');
  }
  // The actual cure, in the one stylesheet all three pages load.
  const theme = read('public/shared/theme.css');
  assert.match(theme, /@media \(hover: none\) and \(pointer: coarse\) \{/);
  assert.match(theme, /input, select, textarea, button \{ font-size: 16px !important; \}/,
    'below 16px iOS zooms on focus and does not come back');
});

test('nothing in a component stylesheet can put a control back under 16px', () => {
  // .bb-f input was 14px, declared later in the file and at higher specificity
  // than the bare `input` rule that was supposed to cover it — so the bid form,
  // the one screen this was reported on, still auto-zoomed.
  const theme = read('public/shared/theme.css');
  const block = theme.slice(theme.indexOf('@media (hover: none) and (pointer: coarse)'));
  assert.match(block, /font-size: 16px !important/,
    'without !important a component rule wins and the zoom comes back');
  // The one-time-code boxes are deliberately larger, not smaller.
  assert.match(block, /\.otpbox input, \.otp \{ font-size: 21px !important; \}/);
});

test('a thumb can hit everything it needs to', () => {
  const theme = read('public/shared/theme.css');
  const block = theme.slice(theme.indexOf('@media (hover: none) and (pointer: coarse)'));
  assert.match(block, /min-height: 44px/, 'both platforms settle on 44px');
  assert.match(block, /input\[type="checkbox"\], input\[type="radio"\] \{ width: 20px; height: 20px; \}/,
    'iOS draws these at the font size and they end up too small to hit');
});

test('the wide tables become cards on a phone rather than scrolling sideways', () => {
  const theme = read('public/shared/theme.css');
  assert.match(theme, /@media \(max-width: 620px\) \{\n\s*table\.stack/);
  assert.match(theme, /content: attr\(data-label\)/, 'a stacked cell has to say what it is');

  // The four tables a person actually reads on a phone.
  const bo = read('public/backoffice/index.html');
  assert.match(bo, /<table id="bookTbl" class="fit stack">/);
  assert.match(bo, /<table id="clientsTbl" class="fit stack">/);
  const cl = read('public/client/index.html');
  assert.match(cl, /<table class="tbl stack" id="myBidsTbl">/);
  assert.match(cl, /<table class="tbl stack" id="myAllotTbl">/);
});

test('every stacked table labels its cells, or the cards are a column of bare numbers', () => {
  // The Clients table is the case that forced this: eight columns, of which three
  // are money. "5,00,000 / 2,00,000 / 3,00,000" in a stack means nothing at all
  // without the labels.
  const app = read('public/backoffice/app.js');
  for (const label of ['Category', 'Status', 'Available', 'Used', 'Free']) {
    assert.ok(app.indexOf('data-label="' + label + '"') >= 0,
      'the Clients table does not label ' + label);
  }
  for (const label of ['Client', 'Branch', 'Qty', 'Price', 'Value', 'Status']) {
    assert.ok(app.indexOf('data-label="' + label + '"') >= 0,
      'the bid book does not label ' + label);
  }
  const client = read('public/client/client.js');
  for (const label of ['Qty', 'Price', 'Value', 'Status', 'Placed', 'Allotted']) {
    assert.ok(client.indexOf('data-label="' + label + '"') >= 0,
      'the investor tables do not label ' + label);
  }
  // Each stacked table needs one heading cell, or every card opens with a label.
  assert.equal((app.match(/class="m rowhead"|class="m rowhead"/g) || []).length, 2,
    'the desk tables need a heading cell each');
  assert.match(client, /class="m rowhead"/);
  assert.match(client, /class="rowhead"/);
});

test('the bid form itself fits a phone', () => {
  const css = read('public/client/style.css');
  // auto-fit with a 140px floor, so five fields become one column on a narrow
  // screen rather than overflowing it.
  assert.match(css, /\.bb-row\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(140px,1fr\)\)/);
  assert.match(css, /@media \(max-width:420px\)\{\n?\s*\.bb-row\{grid-template-columns:1fr\}/);
  // The actions wrap instead of running off the edge.
  assert.match(css, /\.bb-actions\{display:flex;flex-wrap:wrap/);
  // And the margin card stacks.
  assert.match(css, /@media \(max-width:560px\)\{ \.mg-grid\{grid-template-columns:1fr\} \}/);
});
