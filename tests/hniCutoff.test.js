'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/* ---------------------------------------------------------------------------
 * "HNI Category will never have an option for cutoff, it will be my own price
 * only"
 *
 * Cut-off is a RETAIL mechanism — SEBI's non-retail leg is a price bid, always —
 * and lib/domain has always refused an HNI cut-off bid. The DESK's form knew that
 * and removed the option; the investor's form did not, so a Non-Retail bidder
 * could pick "Cut-off price", fill the whole form and only be told after Check.
 * One rule, in public/shared/bidmath.js, read by all three screens.
 * ------------------------------------------------------------------------- */

// bidmath is a browser file: give it a window and read what it hangs on it.
function bidmath() {
  const w = {};
  new Function('window', read('public', 'shared', 'bidmath.js'))(w);
  return w.OFS_BIDMATH;
}

test('cut-off is retail only, and only where the issue allows it', () => {
  const m = bidmath();
  assert.equal(m.cutoffAllowed({ cutoff_flag: true }, 'HNI'), false);
  assert.equal(m.cutoffAllowed({ cutoff_flag: true }, 'Retail'), true);
  assert.equal(m.cutoffAllowed({ cutoff_flag: false }, 'Retail'), false,
    'the desk can switch cut-off off for an issue');
});

test('the server refuses it too, so the option could only ever be refused', () => {
  assert.match(read('lib', 'domain.js'),
    /Cut-off bidding is not available to Non-Retail \(HNI\) bidders\./);
});

test("the investor's form builds its bid types from that rule", () => {
  const c = read('public', 'client', 'client.js');
  assert.match(c, /bidTypeOptions\(i, cat, mine && mine\.is_cutoff\)/,
    'the select is rendered from the rule, not hard-coded');
  assert.match(c, /OFS_BIDMATH\.cutoffAllowed\(i, cat\)/);
  // ...and switching Retail -> HNI with cut-off showing must not leave it there.
  assert.match(c, /function applyBidTypes\(box\)/);
  assert.equal((c.match(/applyBidTypes\(box\);/g) || []).length, 2,
    'both change handlers — the Place bid page and the issues list');
  assert.ok(!/'<option value="cutoff"' \+ \(mine/.test(c),
    'the hard-coded pair of options is gone');
});

test('a new retail bid still starts at cut-off', () => {
  const c = read('public', 'client', 'client.js');
  const fn = /function bidTypeOptions[\s\S]*?\n}/.exec(c)[0];
  assert.match(fn, /wantCutoff !== false/,
    'undefined means a new bid; removing the option must not change the default');
});

test('the desk reads the shared rule rather than its own copy', () => {
  const a = read('public', 'backoffice', 'app.js');
  assert.match(a, /return window\.OFS_BIDMATH\.cutoffAllowed\(issue, category\);/);
  assert.ok(!/if \(category !== 'Retail'\) return false;/.test(a),
    'the second copy is what let the two screens disagree');
});

/* ------------------------------------------------- and the gap under it ----- */

test('the compacted title bar rule does not flatten the action bar', () => {
  const css = read('public', 'backoffice', 'style.css');
  // The action bar is class="bar pb-actions": a blanket `.pb-card .bar` with
  // !important beat its own margin-top and jammed the buttons under the total.
  assert.match(css, /#pane-place \.pb-card > \.bar:first-child \{ margin: 0 0 8px !important; \}/);
  assert.ok(!/#pane-place \.pb-card \.bar \{ margin: 0 0 8px !important; \}/.test(css));
  assert.match(css, /#pane-place \.pb-actions \{ gap: 6px 8px; margin: 12px 0 0; \}/);
  assert.match(css, /#pane-place \.pb-total \{ margin-top: 12px;/,
    'one step down the whole form — 8 here and 12 below reads as a missing gap');
});
