'use strict';
/**
 * "Placed" is not "accepted by the exchange".
 *
 * A bid this application accepts sits in the desk's book until the file is built
 * and uploaded, and the exchange blocks margin at THAT moment, against whatever the
 * client has then — not against the margin this app checked when the form was
 * filled. A client whose margin moves in between has a bid the screen called fine
 * and the exchange refuses, and the only answer to "but your system accepted it" is
 * to have said so at the time.
 *
 * So the sentence is returned by the API with every accepted bid, and the two front
 * ends carry a fallback. A fallback that drifts is the copy that ends up in front of
 * a client, so it is checked here character for character.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const notices = require('../lib/notices');

test('the sentence says what it has to say', () => {
  const n = notices.BID_ACCEPTED;
  assert.match(n, /margin available at the time the bid is submitted to the exchange/,
    'the whole point of the message is missing');
  assert.match(n, /acceptance by the exchange/);
  assert.match(n, /recorded with the OFS desk/, 'it must be clear the bid is not AT the exchange yet');
  // No internal system names in anything a client reads.
  assert.ok(!/\b(LD|Ananta|ofs_bid|ofs\.|schema)\b/i.test(n), 'internal names in client-facing copy');
});

test('every accepted bid carries it — place and modify, all three logins', () => {
  const bids = read('routes/bids.js');
  const portal = read('routes/clientPortal.js');
  // desk place + desk modify
  assert.equal((bids.match(/notice: notices\.BID_ACCEPTED/g) || []).length, 2,
    'the desk must return the notice on place AND modify');
  // client place + client modify + branch place + branch modify
  assert.equal((portal.match(/notice: notices\.BID_ACCEPTED/g) || []).length, 4,
    'the portal must return it for a client and for a branch, on place AND modify');

  // And NOT on a cancel: there is nothing pending at the exchange to condition.
  for (const [name, src] of [['bids', bids], ['portal', portal]]) {
    const cancels = src.split('\n')
      .filter((l) => /cancelBid\(/.test(l) || /notice: notices/.test(l));
    void cancels; void name;
  }
  assert.ok(!/cancelBid[\s\S]{0,200}notice: notices\.BID_ACCEPTED/.test(bids),
    'a withdrawal is not subject to exchange margin');
});

test('both front ends fall back to exactly the server’s words', () => {
  // Pull the fallback out of each browser file and compare the built string, not
  // the source — they are written as concatenations and wrap differently.
  for (const p of ['public/backoffice/app.js', 'public/client/client.js']) {
    const m = /var BID_ACCEPTED_NOTE =\n?([\s\S]*?);\n/.exec(read(p));
    assert.ok(m, p + ' has no BID_ACCEPTED_NOTE fallback');
    // eslint-disable-next-line no-new-func
    const value = new Function('return ' + m[1].trim())();
    assert.equal(value, notices.BID_ACCEPTED, p + ' has drifted from lib/notices');
  }
});

test('the server’s own words are what get shown, not the fallback', () => {
  // The fallback is for an older server, not for every day. Both files must read
  // r.notice first and fall back only when it is absent.
  for (const p of ['public/backoffice/app.js', 'public/client/client.js']) {
    const src = read(p);
    assert.ok(/r\.notice\s*\|\|\s*BID_ACCEPTED_NOTE/.test(src) ||
              /\(r && r\.notice\)\s*\|\|\s*BID_ACCEPTED_NOTE/.test(src),
      p + ' ignores what the server sent');
  }
});

test('the desk confirmation outlives the screen it was created on', () => {
  const src = read('public/backoffice/app.js');
  // The bug this pins: the confirmation was written into the place-bid form's own
  // result box, and a MODIFY calls endModify() (which clears that box) and jumps
  // to the bid book — so the message was gone before anyone read it.
  assert.match(src, /function showBidDone\(/);
  assert.match(src, /if \(editing\) \{ endModify\(\); showTab\('book'\); \}\n\s*\/\/[\s\S]{0,200}?showBidDone\(r, editing\);/,
    'showBidDone must run AFTER endModify and the tab switch');
  // It used to be a banner pinned above the panes, which is one way of living
  // outside them. It is now a notification in the fixed stack at the bottom of
  // the screen, which is another - and that stack is a sibling of every pane, so
  // switching tabs cannot take the confirmation with it.
  assert.match(read('public/backoffice/index.html'), /<div class="toast" id="toast"><\/div>/,
    'there is no notification stack for the confirmation to live in');
  assert.match(read('public/backoffice/app.js'), /BID_DONE = notify\(\{/,
    'the confirmation is not going through the notification stack');
});
