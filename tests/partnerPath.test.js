'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* The branch/AP screens are the desk's screens, served a second time, and every
 * call they make is rewritten to the partner endpoints by partnerPath. The table
 * and the function are lifted out of the shipped file and exercised here, so this
 * tests the mapping that actually runs rather than a copy of it. */
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'backoffice', 'app.js'), 'utf8');

function loadMapper() {
  const table = SRC.slice(SRC.indexOf('var PARTNER_ROUTES = ['),
                          SRC.indexOf('];', SRC.indexOf('var PARTNER_ROUTES = [')) + 2);
  const fnAt = SRC.indexOf('function partnerPath(');
  const fn = SRC.slice(fnAt, SRC.indexOf('\n}', fnAt) + 2);
  return new Function(table + '\n' + fn + '\nreturn partnerPath;')();
}
const partnerPath = loadMapper();

/* Reading the bid book and placing a bid are the same path and different
 * endpoints: /me/bids is read-only over the branch's own clients, /branch/bids is
 * where a bid is written. Both used to map to /me/bids, so every POST reached a
 * GET-only route, matched nothing, and came back as the server's catch-all 404 -
 * which the screen renders as "That record no longer exists", about a bid that
 * was never written. A branch could validate, modify and withdraw, but not place. */
test('a branch PLACING a bid reaches the branch endpoint', () => {
  assert.equal(partnerPath('/bids', 'POST'), '/client/api/branch/bids');
});

test('a branch READING the book still reaches its own book', () => {
  assert.equal(partnerPath('/bids', 'GET'), '/client/api/me/bids');
  assert.equal(partnerPath('/bids?issue_id=4', 'GET'), '/client/api/me/bids?issue_id=4');
});

test('no method given is a read, as it always was', () => {
  assert.equal(partnerPath('/bids'), '/client/api/me/bids');
});

test('modify and withdraw were never broken and stay put', () => {
  assert.equal(partnerPath('/bids/41', 'PUT'), '/client/api/branch/bids/41');
  assert.equal(partnerPath('/bids/41', 'DELETE'), '/client/api/branch/bids/41');
});

test('validate and the confirmation code go to the branch endpoints', () => {
  assert.equal(partnerPath('/bids/validate', 'POST'), '/client/api/branch/bids/validate');
  assert.equal(partnerPath('/bids/otp', 'POST'), '/client/api/branch/bids/otp');
});

test('the rest of the map is unchanged', () => {
  assert.equal(partnerPath('/me'), '/client/api/me');
  assert.equal(partnerPath('/clients?limit=10'), '/client/api/me/clients?limit=10');
  assert.equal(partnerPath('/clients/ASH1001'), '/client/api/me/clients/ASH1001');
  assert.equal(partnerPath('/issues'), '/client/api/issues');
  assert.equal(partnerPath('/settings'), '/client/api/me/settings');
  assert.equal(partnerPath('/dashboard?as_on=2026-09-12'),
    '/client/api/me/dashboard?as_on=2026-09-12');
});

test('a desk-only endpoint is refused rather than guessed at', () => {
  for (const p of ['/margin', '/export/BSE/preview', '/audit']) {
    assert.throws(() => partnerPath(p, 'GET'), /not available to a branch/);
  }
});
