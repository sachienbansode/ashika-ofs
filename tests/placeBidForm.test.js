'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'backoffice', 'app.js'), 'utf8');
const fn = (name) => {
  const i = SRC.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return SRC.slice(i, i + 3000);
};

/* What the form must not carry from one bid to the next. */

test('clearBidForm empties the numbers and leaves the exchange alone', () => {
  const f = fn('clearBidForm');
  assert.match(f, /#pbQty/);
  assert.match(f, /#pbPrice/);
  assert.match(f, /#pbType/);
  assert.ok(f.indexOf('#pbExch') < 0,
    'the exchange is cleared too - it is the desk standing choice and the form re-derives it');
});

test('it refuses to touch a form that is mid-modify', () => {
  assert.match(fn('clearBidForm'), /if \(STATE\.editing\) return;/);
});

test('choosing an issue clears the numbers but not the client', () => {
  const i = SRC.indexOf("$('#pbIssue').addEventListener('change'");
  assert.ok(i >= 0, 'the issue listener is gone');
  const block = SRC.slice(i, i + 600);
  assert.match(block, /clearBidForm\(false\)/,
    'picking an issue no longer clears the previous quantity and price');
});

test('leaving the Place bid tab clears the client too', () => {
  const f = fn('showTab');
  assert.match(f, /STATE\.tab === 'place' && t !== 'place'/);
  assert.match(f, /clearBidForm\(true\)/);
});

test('a placed bid and a withdrawal both leave an empty form', () => {
  assert.match(fn('placeBid'), /clearBidForm\(true\)/);
  assert.match(fn('cancelBid'), /clearBidForm\(true\)/);
});

/* Only one live bid per client per scrip. The desk used to learn that at
 * Validate, or at Place - after the price, the quantity and the client code. */

test('an existing live bid is detected as soon as issue and client are known', () => {
  const i = SRC.indexOf("var box = $('#pbExisting');");
  const block = SRC.slice(i, i + 8000);
  assert.match(block, /DUPLICATE_BID = mine\[0\] \|\| null/);
  assert.match(block, /b\.status === 'Live' \|\| b\.status === 'Modified'/,
    'a modified bid is the same bid, and counts');
  assert.match(block, /STATE\.editing && String\(STATE\.editing\.id\) === String\(b\.id\)/,
    'the bid being modified must not block its own form');
});

test('it says so, disables Place, and offers the two ways out', () => {
  const i = SRC.indexOf("var box = $('#pbExisting');");
  const block = SRC.slice(i, i + 8000);
  assert.match(block, /toast\('Bid already placed'/, 'nothing is said until Validate');
  assert.match(block, /pl\.disabled = true/, 'Place is still clickable');
  assert.match(block, /data-edit="' \+ DUPLICATE_BID\.id/, 'no Modify button on the warning');
  assert.match(block, /data-cancel="' \+ DUPLICATE_BID\.id/, 'no Withdraw button on the warning');
});

test('Place refuses a duplicate even if the button is reached', () => {
  assert.match(fn('placeBid'), /if \(!editing && DUPLICATE_BID\)/);
});

/* The client's own code, in the message asking them to approve a bid. */
test('the confirmation email and text both carry the client code', () => {
  const otp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bidOtp.js'), 'utf8');
  assert.match(otp, /function confirmEmail\(name, code, action, issue, detail, who, mins, ucc\)/);
  assert.match(otp, /Client code/);
  assert.match(otp, /for \${ld\.norm\(clientUcc\)}/, 'the text message has no client code');
});
