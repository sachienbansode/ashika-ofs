'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const ANANTA = read('db', 'anantaAdapter.js');
const BRANCH = read('db', 'branchAdapter.js');
const PORTAL = read('routes', 'clientPortal.js');
const DESK = read('routes', 'clients.js');
const LD = read('db', 'ldAdapter.js');
const APP = read('public', 'backoffice', 'app.js');

/* ---------------------------------------------------------------------------
 * "Display Active and Dormant clients for respective AP, order can be placed
 *  for active clients only."
 *
 * Two questions that were being answered by one string. A branch's LIST was
 * scoped with the same SQL that decides whether a bid is allowed, so a dormant
 * client disappeared from the AP's screen altogether — and typing their code
 * answered "That UCC is not one of your clients", which is false and sends the
 * AP to the wrong person to fix it.
 * ------------------------------------------------------------------------- */

test('seen and allowed are two different pieces of SQL', () => {
  assert.match(ANANTA, /const CLIENT_ACTIVE_SQL = "lower\(btrim\(COALESCE\(u\.status, ''\)\)\) = 'active'";/,
    'the bid gate moved or changed shape');
  assert.match(ANANTA, /const CLIENT_VISIBLE_SQL = .*IN \('active', 'dormant'\)/,
    'there is no separate "may be seen" rule');
  assert.match(ANANTA, /CLIENT_ACTIVE_SQL, CLIENT_VISIBLE_SQL/, 'the new rule is not exported');
});

test('visible is wider than active, and only by dormant', () => {
  const m = ANANTA.match(/const CLIENT_VISIBLE_SQL = "([^"]+)"/);
  assert.ok(m, 'CLIENT_VISIBLE_SQL is gone');
  assert.ok(/'active'/.test(m[1]), 'an active client must still be visible');
  assert.ok(/'dormant'/.test(m[1]), 'a dormant client must be visible');
  assert.ok(!/closed|suspended|inactive/i.test(m[1]),
    'a closed or suspended account must not appear on a branch list');
});

test("the branch's list carries dormant clients", () => {
  const i = BRANCH.indexOf('async function uccsOfBranch');
  const body = BRANCH.slice(i, BRANCH.indexOf('async function', i + 10));
  assert.match(body, /CLIENT_VISIBLE_SQL/, 'the list is still scoped to active only');
  assert.ok(!/CLIENT_ACTIVE_SQL/.test(body), 'the bid gate is still narrowing the list');
});

test('ownership is ownership, not eligibility', () => {
  const i = BRANCH.indexOf('async function branchHasClient');
  const body = BRANCH.slice(i, BRANCH.indexOf('async function', i + 10));
  assert.match(body, /CLIENT_VISIBLE_SQL/,
    'a dormant client is still answered as "not your client"');
});

test('the bid gate is untouched — only an active client may bid', () => {
  const i = LD.indexOf('async function eligibility');
  const body = LD.slice(i, i + 400);
  assert.match(body, /active: c\.is_active === true/,
    'eligibility no longer insists on the active flag');
  // is_active itself is still the account record's status, and only that.
  assert.match(LD, /\(lower\(btrim\(COALESCE\(u\.status, ''\)\)\) = 'active'\)\s+AS is_active/,
    'the definition of is_active has drifted');
});

test('the refusal no longer blames the status', () => {
  assert.match(PORTAL, /message: 'That client is not mapped to your branch\.'/,
    'the message still says "or is not active" for a client who now IS listed');
});

/* --------------------------------------------------------------- the screens */

test('every client row carries the status word, not just a flag', () => {
  assert.match(PORTAL, /status: c\.dwh_status \|\| null/, 'the partner list sends no status');
  assert.match(DESK, /status: c\.dwh_status \|\| null/, 'the desk list sends no status');
  assert.match(DESK, /status: client\.dwh_status \|\| null/, 'one client sends no status');
});

test('the screen says Dormant rather than the flat Inactive', () => {
  assert.match(APP, /function clientStatusLabel\(c\)/);
  assert.match(APP, /function clientStatusChip\(c\)/);
  const f = APP.slice(APP.indexOf('function clientStatusLabel('), APP.indexOf('function clientBranch('));
  assert.match(f, /raw\.charAt\(0\)\.toUpperCase\(\)/, 'the raw status is not titled for display');
  assert.match(f, /dormant/i, 'dormant gets no chip of its own');
});

test('a dormant client is listed and is plainly not biddable', () => {
  assert.match(APP, /esc\(clientStatusLabel\(c\)\)/, 'the status chip is still a boolean');
  assert.match(APP, /dormant — cannot bid/, 'a dormant row does not say why there is no button');
  // The button itself is still gated on ACTIVE, not on "is listed".
  assert.match(APP, /\+ \(clientActive\(c\)\s*\n\s*\? '<button class="mini" data-bidfor="/,
    'Place bid is no longer gated on the active flag');
});
