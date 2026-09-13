'use strict';
/**
 * The order confirmation email, the reference it quotes, and the switch that
 * decides whether any of it happens.
 *
 * The risk here is not a broken template — it is sending. This database's client
 * master holds live investor addresses, so the default has to be OFF, the desk has
 * to be asked before turning it on, and a mail failure must never be able to turn
 * an accepted bid into an error the client sees.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const d = require('../lib/domain');
const { bidConfirmEmail, actorPhrase } = require('../lib/templates/bidConfirm');
const bidMail = require('../lib/bidMail');
const notices = require('../lib/notices');

/* ------------------------------------------------- the application reference -- */

test('every bid reference carries the client’s UCC', () => {
  const ref = d.makeRef('OFS', 'S247683');
  assert.match(ref, /^OFS-S247683-\d{6}-\d{6}[A-Z0-9]{4}$/, 'got ' + ref);
  const [, ucc] = ref.split('-');
  assert.equal(ucc, 'S247683', 'the UCC must be readable straight out of the reference');
});

test('the reference is built on IST, not the server clock', () => {
  // The server runs UTC. A bid at 00:30 IST is still 19:00 the previous day in
  // UTC, so a reference stamped from the server clock would carry yesterday's
  // date while the book, the file and the client's statement all said today.
  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: '2-digit', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  assert.match(d.makeRef('OFS', 'X1'), new RegExp('-' + ist.year + ist.month + ist.day + '-'));
  assert.ok(!/getFullYear\(\)|getMonth\(\)|getDate\(\)/.test(
    /function makeRef[\s\S]*?\n}/.exec(read('lib/domain.js'))[0]),
    'makeRef is back on the server clock');
});

test('a UCC with punctuation still makes a usable reference', () => {
  assert.match(d.makeRef('OFS', 'ash-1001/x'), /^OFS-ASH1001X-/);
  assert.match(d.makeRef('OFS', ''), /^OFS-NOUCC-/, 'never an empty segment');
  assert.match(d.makeRef('OFS', null), /^OFS-NOUCC-/);
});

test('references do not collide, and a collision is retried anyway', () => {
  const seen = new Set();
  for (let i = 0; i < 20000; i++) seen.add(d.makeRef('OFS', 'S247683'));
  assert.ok(seen.size > 19800, 'too many collisions in one second: ' + seen.size);
  // ofs_bid.ref is UNIQUE, so a clash would reject a live bid. One retry.
  const src = read('lib/bidService.js');
  assert.match(src, /e\.code === '23505' && \/ref\/\.test\(String\(e\.constraint/);
  assert.match(src, /makeRef\('OFS', b\.client_ucc\)/, 'the UCC must reach makeRef');
  // …but a duplicate LIVE bid is a different constraint and must still surface.
  assert.match(src, /A duplicate live bid is a different constraint/);
});

/* ------------------------------------------------------------- the template -- */

const BID = {
  ref: 'OFS-S247683-260913-142509XQ7B', client_ucc: 'S247683', client_name: 'A Investor',
  symbol: 'COALINDIA', company: 'Coal India Ltd', category: 'Retail', qty: 500,
  price: 400, is_cutoff: false, value: 200000, exchange: 'BSE', placed_by: 'ap',
  created_at: '2026-09-13T09:09:00Z'
};

test('the confirmation says what was done, to what, and on whose authority', () => {
  const m = bidConfirmEmail(BID, 'place', { copyTo: 'partner@example.com' });
  assert.match(m.subject, /Bid confirmation — COALINDIA · OFS-S247683-260913-142509XQ7B/);
  for (const want of ['OFS-S247683-260913-142509XQ7B', 'S247683', 'COALINDIA', '500 shares',
                      '₹400.00', '₹2,00,000.00', 'BSE', 'your Authorised Partner',
                      'partner@example.com']) {
    assert.ok(m.html.indexOf(want) >= 0, 'missing from the email: ' + want);
  }
  // The standing condition, in the server's own words.
  assert.ok(m.html.indexOf(notices.BID_ACCEPTED_EMAIL) >= 0);
  // Times in IST. 09:09 UTC is 14:39 IST — a confirmation timed in UTC is worse
  // than none, because the client will compare it with their own clock.
  assert.match(m.html, /14:39 IST/);
});

test('the three actions read differently, and only the live ones carry the condition', () => {
  assert.match(bidConfirmEmail(BID, 'modify', {}).html, /has been changed/);
  const cancel = bidConfirmEmail(BID, 'cancel', {}).html;
  assert.match(cancel, /has been withdrawn/);
  assert.match(cancel, /margin held against it is released/);
  assert.ok(cancel.indexOf(notices.BID_ACCEPTED_EMAIL) < 0,
    'a withdrawn bid is not subject to exchange margin — saying so would be nonsense');
});

test('a cut-off bid says cut-off, not a made-up price', () => {
  const m = bidConfirmEmail(Object.assign({}, BID, { is_cutoff: true, price: null }), 'place', {});
  assert.match(m.html, /Cut-off price/);
  assert.ok(!/₹0\.00/.test(m.html), 'a null price must never print as zero');
});

test('the email carries the client’s own details and nothing more', () => {
  const m = bidConfirmEmail(Object.assign({}, BID, {
    pan: 'ABCDE1234F', mobile: '9876543210', email: 'x@y.com', available_margin: 500000
  }), 'place', {});
  for (const leak of ['ABCDE1234F', '9876543210', '5,00,000']) {
    assert.ok(m.html.indexOf(leak) < 0, 'PII or margin leaked into the confirmation: ' + leak);
  }
});

test('the actor is described, never identified by an internal id', () => {
  assert.equal(actorPhrase('client'), 'by you, on the OFS portal');
  assert.equal(actorPhrase('ap'), 'by your Authorised Partner');
  assert.equal(actorPhrase('branch'), 'by your branch');
  assert.equal(actorPhrase('desk'), 'by the Ashika OFS desk on your instruction');
  assert.equal(actorPhrase('something_new'), 'on your account', 'an unknown value must not print raw');
});

test('an unescaped scrip or name cannot inject markup', () => {
  const m = bidConfirmEmail(Object.assign({}, BID, {
    client_name: '<script>x</script>', symbol: 'A&B"C<'
  }), 'place', {});
  assert.ok(m.html.indexOf('<script>x</script>') < 0);
  assert.match(m.html, /&lt;script&gt;/);
  assert.match(m.html, /A&amp;B&quot;C&lt;/);
});

/* ------------------------------------------------------------ the switch ----- */

test('confirmation email is OFF by default, in the defaults and in the reader', () => {
  assert.match(read('lib/settings.js'), /bid_email_confirm: '0'/);
  assert.match(read('lib/bidMail.js'),
    /String\(cfg\.bid_email_confirm == null \? '0' : cfg\.bid_email_confirm\) === '1'/,
    'an absent setting must read as OFF, not as ON');
});

test('turning it on is confirmed with the person first; turning it off is not', () => {
  const app = read('public/backoffice/app.js');
  assert.match(app, /var CONFIRM_ON = \{/);
  assert.match(app, /bid_email_confirm:\s*\n?\s*'Switch ON order confirmation emails\?/);
  assert.match(app, /if \(CONFIRM_ON\[key\] && String\(el\.value\) === '1' && !window\.confirm\(CONFIRM_ON\[key\]\)\)/,
    'the prompt must only guard switching ON');
  // And the value the desk declined must not be left showing as saved.
  assert.match(app, /loadSettings\(\);\s*\/\/ put the control back where it was/);
});

test('the setting is editable and the hint says who gets mailed', () => {
  const src = read('routes/settings.js');
  assert.match(src, /bid_email_confirm: \{/);
  assert.match(src, /check: \(v\) => \['0', '1'\]\.includes\(String\(v\)\)/);
  assert.match(src, /OFF by default/);
  assert.match(src, /these go to real investors/);
});

/* ------------------------------------------------------------- the sending --- */

test('every bid write sends a confirmation, and never waits for it', () => {
  for (const [file, n] of [['routes/bids.js', 3], ['routes/clientPortal.js', 6]]) {
    const src = read(file);
    const calls = src.match(/bidMail\.sendBidConfirm\(req, r, '(place|modify|cancel)'[^)]*\);/g) || [];
    assert.equal(calls.length, n, file + ' does not confirm every bid write');
    assert.ok(!/await bidMail\.sendBidConfirm/.test(src),
      file + ' awaits the mail — a dead SMTP host would delay or fail an accepted bid');
  }
});

test('a mail failure can never reach the caller as a failed bid', () => {
  const src = read('lib/bidMail.js');
  // One try/catch around the whole thing, and it returns rather than rethrows.
  assert.match(src, /\} catch \(e\) \{[\s\S]{0,400}?return \{ sent: false, reason: 'error'/);
  assert.ok(!/throw /.test(src), 'bidMail must never throw');
});

test('the addresses come from the master and the session, never from the request', () => {
  const src = read('lib/bidMail.js');
  assert.match(src, /ld\.eligibility\(bid\.client_ucc\)/, 'the client address must come from the master');
  assert.ok(!/req\.body/.test(src), 'an address taken from the request could be redirected by the sender');
  // The actor's copy is the session's address.
  assert.equal(bidMail.actorOf({ user: { email: 'desk@ashikagroup.com' } }).email, 'desk@ashikagroup.com');
  assert.equal(bidMail.actorOf({ portal: { kind: 'ap', loginEmail: 'ap@x.com' } }).email, 'ap@x.com');
  assert.equal(bidMail.actorOf({ portal: { kind: 'client', ucc: 'S1' } }).email, null,
    'a client bidding for themselves gets one email, not two');
});
