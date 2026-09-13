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

test('zoom is off, and off in the way that actually works on iOS', () => {
  // The desk asked for this. The part worth pinning is that the meta tag is not
  // enough: iOS Safari has ignored user-scalable=no and maximum-scale since iOS
  // 10, so on an iPhone — which is where this was reported — the tag alone does
  // nothing. The gesture handlers are what stop it there.
  for (const p of PAGES) {
    const m = /<meta name="viewport" content="([^"]+)">/.exec(read(p));
    assert.match(m[1], /maximum-scale=1/, p);
    assert.match(m[1], /user-scalable=no/, p);
    assert.match(read(p), /<script src="\/shared\/nozoom\.js"><\/script>/,
      p + ' does not load the gesture guard, so iOS will still pinch-zoom');
  }
  const js = read('public/shared/nozoom.js');
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    assert.match(js, new RegExp("addEventListener\\('" + ev + "'"), 'iOS needs ' + ev);
  }
  // passive:false, or preventDefault is ignored and the whole file does nothing.
  assert.equal((js.match(/\{ passive: false \}/g) || []).length, 5);
  // One finger is a scroll and must still work.
  assert.match(js, /if \(e\.touches && e\.touches\.length > 1\) e\.preventDefault\(\);/);
  // Double-tap is the CSS half.
  assert.match(read('public/shared/theme.css'), /touch-action: manipulation/);
  // A tap on a field must not be swallowed, or the keyboard stops opening.
  assert.match(js, /closest\('input, select, textarea, button, a, \[contenteditable\]'\)/);
});

test('the 16px minimum still stands — it is what has to carry readability now', () => {
  // With zoom off, a person who cannot read a control can no longer magnify it.
  // The font floor stops being a convenience and becomes the whole accommodation.
  const theme = read('public/shared/theme.css');
  assert.match(theme, /input, select, textarea, button \{ font-size: 16px !important; \}/);
  assert.match(theme, /-webkit-text-size-adjust: 100%/);
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

/* ---------------------------------------------------------------------------
 * The phone shell, and staying where you were.
 * ------------------------------------------------------------------------ */

test('the phone gets a bottom bar and a one-row header, not a squeezed desktop', () => {
  const css = read('public/backoffice/style.css');
  assert.match(css, /@media \(max-width: 720px\) \{/);
  assert.match(css, /\.tabbar \{\n\s*position: fixed; left: 0; right: 0; bottom: 0/);
  assert.match(css, /nav\.tabs \{ display: none; \}/, 'the desktop strip must go on a phone');
  // The header was three rows and 280px of an 844px screen before any content.
  assert.match(css, /height: calc\(54px \+ env\(safe-area-inset-top\)\)/);
  // The bar is fixed over the page, so the page has to end above it.
  assert.match(css, /main \{ padding-bottom: calc\(70px \+ env\(safe-area-inset-bottom\)\); \}/);
  // And it is a phone idea only.
  assert.match(css, /@media \(min-width: 721px\) \{ \.tabbar \{ display: none !important; \} \}/);
});

test('the header folds by MOVING its controls, never by copying them', () => {
  // Two Refresh buttons, one of them wired to nothing, would be a worse bug than
  // the layout it was meant to fix — and every listener bound in boot() keeps
  // working only because these are the same elements.
  const src = read('public/backoffice/app.js');
  assert.match(src, /function foldHeader\(\)/);
  assert.match(src, /function restoreHeader\(\)/);
  assert.match(src, /sheet\.appendChild\(el\)/, 'moved, not cloned');
  assert.ok(!/cloneNode/.test(src), 'a cloned control is a control wired to nothing');
  // Growing the window past the phone layout has to put them back and close up.
  assert.match(src, /matchMedia\('\(max-width: 720px\)'\)/);
  assert.match(src, /onChange = function \(\) \{ closeSheets\(\); buildTabBar\(\); \}/);
});

test('the bottom bar is built from the tabs this session actually has', () => {
  const src = read('public/backoffice/app.js');
  // Built AFTER the two sweeps that remove desk-only and partner-only tabs, so a
  // branch can never get a bar button pointing at a desk screen.
  const boot = src.slice(src.indexOf('PARTNER_ONLY_TABS.forEach'));
  assert.match(boot.slice(0, 600), /buildTabBar\(\);/);
  assert.match(src, /var tabs = \$\$\('#tabs button'\);/);
  // Four across a 390px screen; the rest go behind More.
  assert.match(src, /var TABBAR_MAX = 4;/);
  assert.match(src, /openMoreSheet/);
  // A section reached from More still lights More up, or the bar looks broken.
  assert.match(src, /more\.classList\.toggle\('on', !onBar\)/);
});

test('a refresh keeps you on the section you were on', () => {
  const app = read('public/backoffice/app.js');
  assert.match(app, /history\.replaceState\(null, '', want\)/);
  assert.match(app, /function restoreTabFromHash\(\)/);
  assert.match(app, /window\.addEventListener\('hashchange', restoreTabFromHash\)/);
  // A bookmarked section this session may not see falls back rather than showing
  // an empty pane.
  assert.match(app, /if \(known\) showTab\(t, true\);/);

  const client = read('public/client/client.js');
  assert.match(client, /function restoreCTabFromHash\(\)/);
  assert.match(client, /history\.replaceState\(null, '', '#' \+ t\)/);
  // …and it is applied when the investor lands in the app, not only on a click.
  assert.match(client, /\/\/ A refresh lands back where they were[\s\S]{0,80}?restoreCTabFromHash\(\);/);
});

test('the rules link is bound once, not once per tab switch', () => {
  // It used to be re-bound inside showCTab, so after four tab switches one click
  // fired the toggle four times and the link looked broken.
  const client = read('public/client/client.js');
  const show = /function showCTab\([\s\S]*?\n}/.exec(client)[0];
  assert.ok(!/addEventListener/.test(show), 'showCTab must not bind listeners');
  assert.match(client, /function bindRulesLink\(\)[\s\S]{0,200}?if \(!rl \|\| rl\.dataset\.bound\) return;/);
});
