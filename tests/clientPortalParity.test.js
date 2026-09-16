'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'client', 'client.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'client', 'index.html'), 'utf8');
const fn = (name) => {
  const i = SRC.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return SRC.slice(i, i + 2500);
};

/* The investor portal, brought into line with what the desk and a partner get. */

/* The issue list reloads every fifteen seconds and the bid form lives inside the
 * issue card, so a refresh rebuilt the form and emptied it under the investor. */
test('the background refresh keeps what is half-typed', () => {
  assert.match(SRC, /function captureBidForms\(\)/);
  assert.match(SRC, /function restoreBidForms\(snap\)/);
  const load = fn('loadIssues');
  assert.ok(load.indexOf('captureBidForms()') < load.indexOf("innerHTML"),
    'the form is captured after the rebuild, which is too late');
  assert.ok(load.indexOf('restoreBidForms(') > load.indexOf("innerHTML"),
    'nothing is put back after the rebuild');
});

test('only a form the investor has touched is restored', () => {
  assert.match(fn('captureBidForms'), /if \(!id \|\| !DIRTY\[id\]\) return;/,
    'an untouched card is restored too, so it never picks up the server copy');
  assert.match(SRC, /DIRTY\[box\.getAttribute\('data-bid-issue'\)\] = true/,
    'nothing ever marks a form as touched');
  assert.match(SRC, /delete DIRTY\[box\.getAttribute\('data-bid-issue'\)\]/,
    'the mark is never cleared, so the card is frozen after the first keystroke');
});

test('the caret goes back where it was', () => {
  const r = fn('restoreBidForms');
  assert.match(r, /back\.focus\(\)/);
  assert.match(r, /setSelectionRange/);
});

/* Modify and Withdraw existed only on the issue card, so an investor who came to
 * My bids to change a bid found a read-only list. */
test('My bids offers Modify and Withdraw', () => {
  assert.match(SRC, /data-bid-modify="/);
  assert.match(SRC, /data-bid-cancel="/);
  assert.match(SRC, /function modifyFromList\(issueId\)/);
  assert.match(SRC, /async function withdrawFromList\(id, ref\)/);
  assert.match(SRC, /\$\('#myBidsTbl'\)\.addEventListener\('click'/,
    'the buttons are drawn but nothing listens for them');
});

test('neither is offered on a bid that cannot be changed', () => {
  assert.match(SRC, /x\.status === 'Live' \|\| x\.status === 'Modified'/);
  assert.match(SRC, /bidStillOpen\(x\)/);
});

test('a closed offer still answers, with the list not yet loaded', () => {
  const f = fn('bidStillOpen');
  assert.match(f, /ISSUES_BY_ID\[String\(x\.issue_id\)\]/);
  assert.match(f, /x\.ret_close : x\.hni_close/,
    'with no issue list in hand every row shows a dash');
});

test('Withdraw from the list uses the same endpoint as the card', () => {
  assert.match(fn('withdrawFromList'), /api\(bidBase\(\) \+ '\/' \+ id, \{ method: 'DELETE' \}\)/);
  assert.match(fn('withdrawBid'), /api\(bidBase\(\) \+ '\/' \+ editing\.id, \{ method: 'DELETE' \}\)/);
});

/* The header said "Cut-off 15:15" over an offer whose window ran to 17:15. */
test('the header shows what actually closes bidding', () => {
  assert.match(SRC, /function showCutoff\(list, settings\)/);
  assert.ok(!/\$\('#cutTime'\)\.textContent = d\.settings\.daily_cutoff/.test(SRC),
    'the header still reads the desk-wide setting straight out of the payload');
  const f = fn('showCutoff');
  assert.match(f, /ret_status === 'Open' \|\| i\.hni_status === 'Open'/);
  assert.match(f, /Math\.min\.apply/, 'with several offers open it must show the next close');
  assert.match(f, /settings\.daily_cutoff/, 'with nothing open there is no fallback');
});

test('the header time is Indian time whatever the device is set to', () => {
  assert.match(fn('hhmmIST'), /timeZone: 'Asia\/Kolkata'/);
});

test('the pill label is not hard-coded to Cut-off any more', () => {
  assert.match(HTML, /data-cut-label/);
  assert.ok(!/<b id="cutTime">15:15<\/b>/.test(HTML),
    'the markup still ships a desk cut-off as the starting value');
});
