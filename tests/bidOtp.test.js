'use strict';
/**
 * The client's confirmation for a bid someone else placed.
 *
 * Ashika's rule: a client acting for themselves needs no code; an AP, a branch or
 * the back office acting FOR them does. The code is what turns "the client agreed"
 * from an assertion by whoever was at the keyboard into a fact on the record.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const bidOtp = require('../lib/bidOtp');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a client acting alone is never asked; everyone else is', () => {
  assert.equal(bidOtp.required('client'), false);
  assert.equal(bidOtp.required('desk'), true);
  assert.equal(bidOtp.required('ap'), true);
  assert.equal(bidOtp.required('branch'), true);
});

test('place, modify and cancel are all covered — withdrawing is theirs to agree to too', () => {
  for (const a of ['place', 'modify', 'cancel']) {
    assert.ok(bidOtp.ACTION_WORDS[a], a + ' has no wording for the client’s message');
  }
});

test('every failure reason has a sentence the desk can act on', () => {
  for (const r of ['missing', 'unknown', 'used', 'expired', 'too_many_attempts', 'wrong', 'mismatch']) {
    assert.ok(bidOtp.message(r).length > 10, r);
  }
  assert.equal(bidOtp.message('something_new'), 'Confirmation failed.');
});

test('the code is bound to client, issue, action and bid — checked, not merely stored', () => {
  const src = read('lib/bidOtp.js');
  // A code the client approved for "cancel my Coal India bid" must not be spendable
  // on placing a new one, or on another client.
  assert.match(src, /ld\.norm\(row\.client_ucc\) === ld\.norm\(clientUcc\)/);
  assert.match(src, /String\(row\.issue_id\) === String\(issueId\)/);
  assert.match(src, /row\.action === action/);
  assert.match(src, /reason: 'mismatch'/);
});

test('the attempt is counted before the comparison', () => {
  // Otherwise a caller that drops the connection mid-request buys a free guess.
  const src = read('lib/bidOtp.js');
  const update = src.indexOf('SET attempts = attempts + 1');
  const compare = src.indexOf('hashMatches');
  assert.ok(update > 0 && compare > update, 'the counter must be incremented before the compare');
});

test('a wrong guess never reveals what the code was for', () => {
  const src = read('lib/bidOtp.js');
  const wrong = src.indexOf("reason: 'wrong'");
  const bound = src.indexOf('const bound =');
  assert.ok(wrong > 0 && bound > wrong, 'binding must be checked only after the code matches');
});

test('the code goes to the CLIENT, read from LD, never to an address in the request', () => {
  const src = read('lib/bidOtp.js');
  assert.match(src, /const client = await ld\.findByUcc\(clientUcc\)/);
  assert.match(src, /to: client\.email/);
  assert.match(src, /to: client\.mobile/);
  assert.ok(!/req\.body/.test(src), 'lib/bidOtp must not read the request at all');
});

test('a client with no contacts is refused with an explanation, not silently skipped', () => {
  const src = read('lib/bidOtp.js');
  assert.match(src, /reason: 'no_contact'/);
  assert.match(src, /no registered email or mobile/);
});

test('the desk validates the bid BEFORE troubling the client for a code', () => {
  // Measured inside each handler, not across the file: confirmOrReject is DEFINED
  // above them all, so a whole-file index comparison proves nothing.
  const src = read('routes/bids.js');
  const handlers = src.split(/router\.(?:post|put|delete)\(/).slice(1);
  let checked = 0;
  for (const h of handlers) {
    // 'await confirmOrReject', not 'confirmOrReject': the function is DEFINED
    // between two handlers, so the bare name matches its own declaration.
    const confirm = h.indexOf('await confirmOrReject(req, res');
    if (confirm < 0) continue;
    const validate = h.indexOf("error: 'validation_failed'");
    const blocked = h.indexOf('cancelBlockedMessage');
    const before = Math.max(validate, blocked);
    assert.ok(before > 0 && before < confirm,
      'a client should not approve a bid that was never going to pass its own checks');
    checked++;
  }
  assert.equal(checked, 3, 'place, modify and cancel should each confirm after their own checks');
});

test('all three desk write paths demand it, and record which code authorised the bid', () => {
  const src = read('routes/bids.js');
  for (const a of ["action: 'place'", "action: 'modify'", "action: 'cancel'"]) {
    assert.ok(src.includes(a), 'routes/bids.js never confirms for ' + a);
  }
  assert.match(src, /otp_verified = true, otp_ref/);
});

test('a branch may only reach its own clients, and a stranger UCC reads as absent', () => {
  const src = read('routes/clientPortal.js');
  assert.match(src, /branches\.branchHasClient\(a\.code, ucc\)/);
  // 404 not 403: confirming a UCC exists but belongs elsewhere tells a branch
  // something about another branch's book.
  assert.match(src, /error: 'not_your_client'/);
  assert.ok(/404[\s\S]{0,200}not_your_client/.test(src) || /not_your_client[\s\S]{0,200}404/.test(src));
});

test('a branch cannot cancel after the cut-off, with no force flag to reach for', () => {
  const src = read('routes/clientPortal.js');
  const branchDelete = src.slice(src.indexOf("router.delete('/branch/bids/"));
  assert.match(branchDelete, /cancelBlockedMessage/);
  assert.ok(!/force/.test(branchDelete), 'the desk keeps a force flag; a branch does not get one');
});

test('the setting exists and defaults to on', () => {
  assert.match(read('lib/settings.js'), /bid_otp_required: '1'/);
  const s = read('routes/settings.js');
  assert.match(s, /bid_otp_required/);
  assert.match(s, /removes the only record that the client agreed/);
});

test('the migration binds the challenge and constrains what it can say', () => {
  const sql = read('db/migrations/018_bid_otp.sql');
  assert.match(sql, /action IN \('place','modify','cancel'\)/);
  assert.match(sql, /requested_by_kind IN \('desk','ap','branch'\)/);
  assert.match(sql, /REFERENCES ofs\.ofs_issue\(id\) ON DELETE CASCADE/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS otp_ref text/);
});
