'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'backoffice', 'style.css'), 'utf8');

/* ---------------------------------------------------------------------------
 * "fix the UI for place bid page, there are no proper gaps in fields in
 * down-side lines"
 *
 * Two separate faults, and the first is the one that made the gap look absent
 * even where there was one. Every field was its own flex column, so a field
 * carrying four lines of hint stood 60px taller than one carrying none (Issue
 * and Category have no hint at all) — the boxes on a wrapped line started at
 * different heights and the space between lines was whatever the tallest cell
 * left over. The fields are now three fixed bands — label, control, hint — so
 * the boxes line up across a line and the hint band absorbs the difference.
 *
 * The second is plain: compaction had cut the row gap to 7px.
 * ------------------------------------------------------------------------- */

const block = (sel) => {
  const i = CSS.indexOf(sel + '{');
  assert.ok(i >= 0, sel + ' is gone from the stylesheet');
  return CSS.slice(i, CSS.indexOf('}', i));
};

test('a field is three bands, so the boxes on a line start at one height', () => {
  const f = block('.pb-row .f');
  assert.match(f, /display:grid/, 'the field went back to being its own column');
  assert.match(f, /grid-template-rows:auto auto 1fr/,
    'the hint band is what absorbs an uneven hint; without it the cells diverge');
});

test('the cells stretch, or the bands line up in each cell and nowhere else', () => {
  assert.match(block('.pb-row'), /align-items:stretch/,
    'align-items:start lets every cell keep its own height again');
});

test('the gap above a control is the row gap, not the row gap plus a margin', () => {
  assert.match(CSS, /\.pb-row \.f select,\.pb-row \.f input\{margin-top:0\}/,
    'the inherited margin-top double-counts the first band');
});

test('compaction may tighten the form but not close the gap between its lines', () => {
  const m = CSS.match(/#pane-place \.pb-row \{ gap: (\d+)px/);
  assert.ok(m, 'the compacted row gap is gone');
  assert.ok(Number(m[1]) >= 12,
    'a desk monitor wraps this form to two or three lines; ' + m[1] + 'px between them reads as none');
});
