'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const APP = read('public', 'backoffice', 'app.js');
const HTML = read('public', 'backoffice', 'index.html');
const CSS = read('public', 'backoffice', 'style.css');
const DESK = read('routes', 'clients.js');
const PORTAL = read('routes', 'clientPortal.js');
const MARGIN = read('routes', 'margin.js');
const LD = read('db', 'ldAdapter.js');

const fn = (src, name, len) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return src.slice(i, i + (len || 4000));
};

/* ---------------------------------------------------------------------------
 * "Display Branch code in client listing in clients tab and in margin listing"
 * ------------------------------------------------------------------------- */

test('the branch code reaches both listings', () => {
  // The client master is the branch mapping; ldAdapter selects it as branch_id.
  assert.match(LD, /c\.branch_id,/, 'the branch column is no longer selected');
  assert.match(DESK, /branch: c\.branch_id \|\| null/, 'the desk list sends no branch');
  assert.match(PORTAL, /branch: c\.branch_id \|\| null, branch_id: c\.branch_id \|\| null/,
    'the partner list sends no branch');
  // The margin list gets it through enrich(), which attaches branch and branch_id.
  assert.match(MARGIN, /ld\.enrich\(r, 'client_ucc'\)/, 'the margin list is no longer enriched');
  assert.match(LD, /branch: c \? c\.branch_id : null,/, 'enrich stopped attaching the branch');
});

test('one reader, whichever endpoint answered', () => {
  const f = fn(APP, 'clientBranch', 300);
  assert.match(f, /c\.branch \|\| c\.branch_id \|\| c\.branch_code/,
    'the screen reads only one of the three spellings the endpoints use');
});

test('the Clients tab has a Branch column', () => {
  const f = fn(APP, 'loadClients', 6000);
  assert.match(f, /<th>Branch<\/th>/, 'no Branch heading');
  assert.match(f, /data-label="Branch">' \+ esc\(clientBranch\(c\) \|\| '—'\)/,
    'no Branch cell, or one the stacked phone layout cannot label');
  // Heading count must match cell count or every row is off by one.
  const head = f.slice(f.indexOf('<thead>'), f.indexOf('</thead>'));
  assert.equal((head.match(/<th[ >]/g) || []).length, 9, 'the header row has changed width');
});

test('the margin listing has a Branch column', () => {
  const f = fn(APP, 'renderMargins', 3000);
  assert.match(f, /<th>Branch<\/th>/, 'no Branch heading on the margin list');
  assert.match(f, /esc\(clientBranch\(m\) \|\| '—'\)/, 'no Branch cell on the margin list');
  const head = f.slice(f.indexOf('<thead>'), f.indexOf('</thead>'));
  const body = f.slice(f.indexOf('page.map'), f.indexOf(").join('')"));
  assert.equal((head.match(/<th[ >]/g) || []).length, 10, 'the header row has changed width');
  assert.equal((body.match(/<td[ >]/g) || []).length, 10, 'the body row no longer matches the header');
});

test('a branch code you cannot search by is decoration', () => {
  const f = fn(APP, 'marginRows', 800);
  assert.match(f, /String\(clientBranch\(m\)\)\.toUpperCase\(\)\.indexOf\(q\) >= 0/,
    'the margin search ignores the branch code');
  assert.match(HTML, /placeholder="Client code, name or branch"/,
    'the search box does not say the branch is searchable');
});

test('the margin window names the branch it is funding', () => {
  const f = fn(APP, 'marginModal', 5000);
  assert.match(f, /' · branch ' \+ clientBranch\(existing\)/,
    'Modify does not say whose client this is');
  assert.match(f, /' · branch ' \+ clientBranch\(c\)/, 'Add does not say whose client this is');
});

/* ------------------------------------------------- confirmation on every write */

test('insert, update and delete each ask first', () => {
  const modal = fn(APP, 'marginModal', 5000);
  assert.match(modal, /window\.confirm\(\(editing \? 'Change the margin for ' : 'Set a margin for '\)/,
    'the one window covers add and modify, and one of them no longer confirms');
  const del = fn(APP, 'deleteMargin', 1400);
  assert.match(del, /!force && !window\.confirm\('Remove the margin record for '/,
    'delete no longer confirms');
  assert.match(del, /rupee\(m\.available, 0\)/, 'the delete prompt does not say what is being removed');
  const reset = fn(APP, 'resetMargins', 1400);
  assert.match(reset, /window\.confirm\('Set ' \+ n \+ ' client margin\(s\) to zero\?/,
    'zero-all no longer confirms');
});

test('the old top-of-page margin form is still gone', () => {
  ['#mgUcc', '#mgAmt', '#mgFetch', '#mgSet'].forEach((id) => {
    assert.ok(APP.indexOf(id) < 0, id + ' is back — two ways to change one figure');
    assert.ok(HTML.indexOf(id.slice(1)) < 0, id + ' is back in the markup');
  });
});

/* ---------------------------------------------------------------------------
 * "we need to find correct way of highlighting the text 'That UCC is not one of
 *  your clients.' which is currently shown in 'Client & margin'"
 * ------------------------------------------------------------------------- */

test('the verdict on a UCC lands under the UCC box', () => {
  assert.match(APP, /function uccVerdict\(text, kind\)/);
  const f = fn(APP, 'uccVerdict', 900);
  assert.match(f, /\$\('#pbUccHint'\)/, 'the verdict does not reach the field hint');
  assert.match(f, /field\.classList\.toggle\('bad', kind === 'bad'\)/,
    'the box itself is not marked, so the error is a line of grey text');
  assert.match(HTML, /id="pbUccHint"/, 'the hint element is gone');
});

test('"not one of your clients" is said at the field, not only in the panel', () => {
  const f = fn(APP, 'loadClientPanel', 4000);
  assert.match(f, /That UCC is not one of your clients\./);
  assert.match(f, /uccVerdict\(why, 'bad'\);/, 'the refusal never reaches the field');
  assert.match(f, /Check the code, or find the client on the Clients tab\./,
    'the AP is told what is wrong but not what to do about it');
});

test('a listed-but-dormant client is a warning, not a refused code', () => {
  const f = fn(APP, 'loadClientPanel', 4000);
  assert.match(f, /blocked \? 'warn' : null/,
    'a dormant client turns the UCC box red as though the code were wrong');
  assert.match(f, /' is ' \+ label\.toLowerCase\(\) \+ ' — cannot bid\.'/,
    'the field no longer names the status');
  assert.match(f, /status is ' \+ label/,
    'the reason is repeated under a label that already said it');
});

test('the error survives the compact layout that hides the hints', () => {
  assert.match(CSS, /#pane-place \.pb-row \.f #pbUccHint\.bad,\s*\n\s*#pane-place \.pb-row \.f #pbUccHint\.warn \{ display: block; \}/,
    'compaction hides the hint, and with it the only thing that says the UCC is refused or dormant');
  assert.match(CSS, /#pane-place \.pb-row \.f\.bad input\{border-color:var\(--red\)/,
    'the refused box is not marked');
});

test('clearing the form clears the verdict too', () => {
  const f = fn(APP, 'clearBidForm', 1400);
  assert.match(f, /uccVerdict\('', null\);/,
    'the last client’s refusal stays under an empty UCC box');
});

test('the check runs as the code is typed, not at Validate', () => {
  const f = fn(APP, 'onUccTyped', 900);
  assert.match(f, /uccVerdict\('Checking ' \+ v \+ '…', null\);/);
  assert.match(f, /setTimeout\(function \(\) \{ loadClientPanel\(v\); \}, 350\);/,
    'the lookup is no longer debounced on keystrokes');
});
