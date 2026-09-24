'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('public/backoffice/app.js');
const HTML = read('public/backoffice/index.html');
const CSS = read('public/backoffice/style.css');

/* The margins screen is a list you search and act on, not a form above a list.
 *
 * It had both: a UCC box, a Fetch client button, an amount and a Save/Replace
 * button across the top, over every margin in the book. Two ways to change one
 * figure, and the form - furthest from the row being read - is the one that got
 * used, with that row's own numbers off screen. */

test('the top form is gone, every part of it', () => {
  for (const id of ['mgUcc', 'mgAmt', 'mgFetch', 'mgSet', 'mgClient', 'mgUsed', 'mgFree']) {
    assert.ok(HTML.indexOf('id="' + id + '"') < 0, 'the markup still has #' + id);
    assert.ok(APP.indexOf("'#" + id + "'") < 0, 'app.js still reaches for #' + id);
  }
  for (const fn of ['showMarginFor', 'marginGate', 'fetchMarginClient', 'setMargin']) {
    assert.ok(APP.indexOf('function ' + fn + '(') < 0, fn + ' is still there');
  }
});

test('search and reset narrow the list by code or name', () => {
  assert.match(HTML, /id="mgQ"/);
  assert.match(HTML, /id="mgGo"/);
  assert.match(HTML, /id="mgClear"/);
  assert.match(APP, /function marginRows\(\)/);
  assert.match(APP, /client_ucc \|\| ''\)\.toUpperCase\(\)\.indexOf\(q\) >= 0/);
  assert.match(APP, /client_name \|\| ''\)\.toUpperCase\(\)\.indexOf\(q\) >= 0/);
  assert.match(APP, /function marginClear\(\)/);
  // The count says what the search left, against the whole book.
  assert.match(APP, /' of ' \+ inr\(all, 0\)/);
});

test('every row carries Modify, Delete and History', () => {
  assert.match(APP, /data-mgedit="/);
  assert.match(APP, /data-mgdel="/);
  assert.match(APP, /data-mglog="/);
});

test('Modify opens the small window, with the client fixed', () => {
  assert.match(APP, /function marginModal\(ucc, existing\)/);
  assert.match(APP, /function editMargin\(ucc\)/);
  const m = APP.slice(APP.indexOf('function marginModal('), APP.indexOf('function editMargin('));
  assert.match(m, /editing \? ' readonly' : ''/,
    'a Modify that lets you change WHICH client is a Modify that funds the wrong one');
  assert.match(m, /window\.confirm\(/, 'the window saves without asking');
  assert.match(CSS, /\.mdl-veil \{/, 'the small window has no styles');
});

test('Add resolves the client code before it can be saved', () => {
  const m = APP.slice(APP.indexOf('function marginModal('), APP.indexOf('function editMargin('));
  assert.match(m, /api\('\/clients\/' \+ encodeURIComponent\(v\)\)/);
  assert.match(m, /Press Tab to confirm the client code first/);
});

test('Delete still asks, and still says what is kept', () => {
  const d = APP.slice(APP.indexOf('async function deleteMargin('), APP.indexOf('async function deleteMargin(') + 1200);
  assert.match(d, /window\.confirm\(/);
  assert.match(d, /The history is kept/);
});

/* ---------------------------------------------- Place bid, in one view ------ */

test('the order form is tightened for a desk monitor, not for a phone', () => {
  assert.match(CSS, /@media \(pointer: fine\) and \(min-width: 900px\) \{/,
    'the compaction is not scoped to a fine pointer');
  const i = CSS.indexOf('@media (pointer: fine) and (min-width: 900px)');
  const block = CSS.slice(i, i + 2600);
  assert.match(block, /#pane-place \.pb-row \.f select,/);
  assert.match(block, /height: 30px/);
  assert.match(block, /#pane-place \.pb-actions \.btn/);
  assert.match(block, /#pane-place \.place-side \.card/);
});

test('the phone keeps its 16px fields, which is what stops iOS zooming', () => {
  const theme = read('public/shared/theme.css');
  assert.match(theme, /font-size:\s*16px\s*!important/);
  const i = CSS.indexOf('@media (pointer: fine) and (min-width: 900px)');
  const block = CSS.slice(i, i + 2600);
  assert.ok(!/pointer:\s*coarse/.test(block), 'the compaction reaches touch screens');
});
