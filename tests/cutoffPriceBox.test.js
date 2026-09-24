'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const APP = read('public', 'backoffice', 'app.js');
const CLIENT = read('public', 'client', 'client.js');
const BIDMATH = read('public', 'shared', 'bidmath.js');
const DOMAIN = read('lib', 'domain.js');
const PORTAL = read('routes', 'clientPortal.js');
const CSS = read('public', 'backoffice', 'style.css');

const fn = (src, name, len) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return src.slice(i, i + (len || 4000));
};

/* ---------------------------------------------------------------------------
 * "If Price type=Cut-off, then display floor price as per issue in price
 *  box(readonly), this is applicable for all types: branch/AP, Client and
 *  Admin/backoffice."
 *
 * A cut-off bid is not a bid without a price. It is held, valued and margined at
 * the price the ISSUE sets — the floor, or the retail cut-off minimum where the
 * offer publishes one. Both forms used to empty the box and grey it out, so the
 * total read "—" against a bid that consumes real margin.
 * ------------------------------------------------------------------------- */

/* The figure itself: the screen must use the same one the server holds the bid
 * at, or the total on the form is not the total that is margined. */
test('there is one definition of what a cut-off bid is priced at', () => {
  assert.match(DOMAIN, /const p = isCutoff \? minPrice\(issue, cat\)/,
    'the server no longer values a cut-off bid at the issue minimum');
  assert.match(BIDMATH, /function minPriceFor\(issue, category\)/);
  // Retail takes cut_price_min where there is one; everything else takes the floor.
  assert.match(BIDMATH, /if \(category === 'Retail'\)[\s\S]{0,200}cut_price_min/);
});

/* ------------------------------------------------------------ desk and partner */

test('the desk form fills the price box on a cut-off bid', () => {
  const f = fn(APP, 'refreshBidForm', 9000);
  assert.match(f, /pEl\.value = mp == null \? '' : String\(mp\);/,
    'the cut-off price is not put in the box');
  assert.match(f, /pEl\.readOnly = true;/, 'the box is not made read-only');
  assert.ok(!/\$\('#pbPrice'\)\.disabled = isCut;/.test(f),
    'the box is still disabled, which renders as broken rather than as fixed');
});

test('switching back to a price bid does not leave the issue’s figure behind', () => {
  const f = fn(APP, 'refreshBidForm', 9000);
  assert.match(f, /pEl\.dataset\.cutfill = '1';/, 'nothing marks the value as auto-filled');
  assert.match(f, /if \(pEl\.dataset\.cutfill === '1'\) \{ pEl\.value = ''; delete pEl\.dataset\.cutfill; \}/,
    'an auto-filled price survives into a price bid as though somebody typed it');
});

test('the hint under the box says the price is the offer’s, not a minimum', () => {
  const f = fn(APP, 'refreshBidForm', 9000);
  assert.match(f, /Cut-off: this bid takes '/, 'the hint still reads as "at or above"');
});

test('a cut-off bid still sends no price of its own', () => {
  // readonly is a screen affordance; the body must not carry a price the server
  // would have to decide whether to trust.
  assert.match(APP, /price: cutoff \? null : Number\(\$\('#pbPrice'\)\.value\) \|\| 0/,
    'the desk now sends the auto-filled price as though the desk typed it');
  assert.match(CLIENT, /price: cutoff \? null : Number\(g\('price'\)\.value\) \|\| 0/,
    'the portal now sends the auto-filled price');
});

test('Fill suggested bid gives the box back to the user', () => {
  const f = fn(APP, 'fillSuggestedBid', 1200);
  assert.match(f, /\$\('#pbPrice'\)\.readOnly = false;/);
  assert.match(f, /delete \$\('#pbPrice'\)\.dataset\.cutfill;/);
  const c = fn(CLIENT, 'fillSuggested', 1400);
  assert.match(c, /g\('price'\)\.readOnly = false;/);
  assert.match(c, /removeAttribute\('data-cutfill'\)/);
});

test('modify opens a cut-off bid with the box read-only, not disabled', () => {
  assert.match(APP, /\$\('#pbPrice'\)\.readOnly = !!bid\.is_cutoff;/);
});

test('a read-only price box does not look like a broken one', () => {
  assert.match(CSS, /#pbPrice\[readonly\]/, 'the filled box is unstyled and reads as disabled');
});

/* --------------------------------------------------------------- the investor */

test('the portal has one function for what a cut-off bid costs', () => {
  assert.match(CLIENT, /function cutoffPriceFor\(i, cat\)/);
  const f = fn(CLIENT, 'cutoffPriceFor', 700);
  assert.match(f, /cat === 'HNI' \? i\.min_price_hni : i\.min_price_retail/,
    'the category no longer decides which minimum applies');
  assert.match(f, /i\.floor_price/, 'there is no fallback to the plain floor');
});

test('the total was being drawn at the retail price for an HNI bid', () => {
  const f = fn(CLIENT, 'recalcTotal', 900);
  assert.match(f, /cutoffPriceFor\(i, cat\)/, 'recalcTotal still reads min_price_retail directly');
  assert.ok(!/Number\(i && i\.min_price_retail\)/.test(f),
    'the old category-blind figure is still in recalcTotal');
});

test('the investor’s price box is filled and read-only on a cut-off bid', () => {
  assert.match(CLIENT, /function applyPriceMode\(box\)/);
  const f = fn(CLIENT, 'applyPriceMode', 1400);
  assert.match(f, /price\.value = cp == null \? '' : String\(cp\);/);
  assert.match(f, /price\.readOnly = true;/);
  assert.match(f, /price\.setAttribute\('data-cutfill', '1'\);/);
  assert.match(f, /price\.removeAttribute\('data-cutfill'\)/);
});

test('the price box follows the CATEGORY as well as the bid type', () => {
  // Retail -> HNI on a cut-off bid changes the price the bid is held at, so the
  // box has to be rewritten. Both handlers, because both screens carry a form.
  const both = CLIENT.split("e.target.matches('[data-bf=\"type\"]') || e.target.matches('[data-bf=\"cat\"]')");
  assert.equal(both.length, 3, 'only one of the two forms reacts to the category');
  assert.ok(!/price\.disabled = e\.target\.value === 'cutoff';/.test(CLIENT),
    'a handler still disables and empties the box instead of filling it');
});

test('a re-render does not leave a stale price in the box', () => {
  const f = fn(CLIENT, 'renderPlace', 1600);
  assert.ok(f.indexOf('applyPriceMode(') > f.indexOf('restoreBidForms('),
    'the price mode is applied before the snapshot is put back, so it is overwritten');
});

test('the offer sends both minimums, so the screen never has to guess', () => {
  assert.match(PORTAL, /min_price_retail: minPrice\(i, 'Retail'\)/);
  assert.match(PORTAL, /min_price_hni: minPrice\(i, 'HNI'\)/);
});

test('the investor’s client code is still not theirs to change', () => {
  const f = fn(CLIENT, 'placePage', 4000);
  assert.match(f, /<span class="k">Client code<\/span>'[\s\S]{0,200}readonly/,
    'the client code became editable on the investor form');
});
