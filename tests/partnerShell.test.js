'use strict';
/**
 * One page, two shells.
 *
 * /backoffice is the desk; /partner is a branch or an Authorised Partner seeing the
 * same screens over their own clients. It is the same file served twice, not a copy,
 * because a copy is two screens that drift.
 *
 * The half of this worth testing is the half that would fail silently: a desk that
 * thinks it is a partner sends staff writes to the portal API, and a partner with a
 * desk tab reaches a screen it has no right to. Both are decided by one constant
 * derived from the URL, so that constant is what gets pinned.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/backoffice/app.js'), 'utf8');

/** Run the routing table and partnerPath() as shipped, under a chosen URL. */
function shellAt(pathname) {
  const ctx = vm.createContext({ location: { pathname } });
  const head = SRC.slice(0, SRC.indexOf('async function api('));
  vm.runInContext(head, ctx);
  return ctx;
}

test('the shell is decided by the URL, and defaults to the desk', () => {
  assert.equal(shellAt('/partner/').PARTNER, true);
  assert.equal(shellAt('/partner').PARTNER, true);
  assert.equal(shellAt('/backoffice/').PARTNER, false);
  assert.equal(shellAt('/backoffice/index.html').PARTNER, false);
  // Anything unrecognised is the desk. A partner shell served from the wrong path
  // is cosmetic; a desk that believes it is a partner would post staff writes to
  // the portal API, so the fallback has to be this way round.
  assert.equal(shellAt('/').PARTNER, false);
  // And not a prefix match: /partnership is not the partner shell.
  assert.equal(shellAt('/partnerships/x').PARTNER, false);
});

test('a partner reaches its own scoped endpoints, not the desk’s', () => {
  const { partnerPath } = shellAt('/partner/');
  assert.equal(partnerPath('/me'), '/client/api/me');
  assert.equal(partnerPath('/dashboard'), '/client/api/me/dashboard');
  assert.equal(partnerPath('/dashboard?as_on=2026-09-12'),
    '/client/api/me/dashboard?as_on=2026-09-12', 'the query string survives');
  assert.equal(partnerPath('/bids?issue_id=3'), '/client/api/me/bids?issue_id=3');
  assert.equal(partnerPath('/clients/A12234'), '/client/api/me/clients/A12234');
  assert.equal(partnerPath('/issues'), '/client/api/issues');
});

test('a partner’s WRITES go through the branch door, where the client confirms', () => {
  const { partnerPath } = shellAt('/partner/');
  // Not /me/bids: reads are scoped views, writes are gated by the client's own
  // one-time code. Sending a write to the read path would be a 404 at best.
  assert.equal(partnerPath('/bids/validate'), '/client/api/branch/bids/validate');
  assert.equal(partnerPath('/bids/otp'), '/client/api/branch/bids/otp');
  assert.equal(partnerPath('/bids/41'), '/client/api/branch/bids/41');
  assert.equal(partnerPath('/bids'), '/client/api/me/bids');
});

test('the desk’s own screens are refused, not quietly rewritten', () => {
  const { partnerPath } = shellAt('/partner/');
  // A silent rewrite is worse than an error: it would send a branch to SOME
  // endpoint, and the first sign of trouble would be data it should not have.
  for (const p of ['/export/log', '/export/NSE', '/circulars', '/margin/bulk',
                   '/margin/reset', '/issues/sync/status', '/issues/archive',
                   '/audit?limit=50']) {
    assert.throws(() => partnerPath(p), /not available to a branch/, p + ' was rewritten');
  }
});

test('the desk is untouched by any of this', () => {
  // Every call on the desk still goes to /api, with the bearer token attached.
  const api = SRC.slice(SRC.indexOf('async function api('), SRC.indexOf('async function api(') + 900);
  assert.match(api, /if \(TOKEN && !PARTNER\) headers\.Authorization = 'Bearer ' \+ TOKEN;/);
  assert.match(api, /var url = PARTNER \? partnerPath\(path\) : '\/api' \+ path;/);
  const { PARTNER } = shellAt('/backoffice/');
  assert.equal(PARTNER, false, 'so the desk takes the /api branch every time');
});

test('the desk’s tabs are removed for a partner, not merely disabled', () => {
  assert.match(SRC, /var DESK_ONLY_TABS = \['export', 'masters'\];/);
  // Disabled invites a support call asking for it to be enabled; removed does not.
  assert.match(SRC, /if \(b\) b\.remove\(\);/);
  assert.match(SRC, /if \(pane\) pane\.remove\(\);/);
  // And showTab refuses them even if something else calls it directly.
  assert.match(SRC, /if \(PARTNER && DESK_ONLY_TABS\.indexOf\(t\) >= 0\) t = 'dash';/);
});

test('the two sessions sign out through their own doors', () => {
  const out = SRC.slice(SRC.indexOf('async function signOut('));
  assert.match(out, /PARTNER \? '\/client\/auth\/logout' : '\/auth\/logout'/);
  // A branch has no back-office login, so an expired session must not land them on
  // a password box they cannot fill.
  assert.match(SRC, /location\.replace\(PARTNER[\s\S]{0,120}\/backoffice\/login\.html/);
});

test('the server serves one directory under both paths', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.use\('\/partner', express\.static\(path\.join\(__dirname, 'public', 'backoffice'\)/,
    'the partner shell must be the same files, not a copy');
});

test('a branch signing in lands on the desk screens, not the investor ones', () => {
  const client = fs.readFileSync(path.join(ROOT, 'public/client/client.js'), 'utf8');
  const verify = client.slice(client.indexOf('async function verifyBranchCode('));
  assert.match(verify, /location\.href = '\/partner\/';/);
  // The investor shell cannot show a book of clients, so a branch must not stay in it.
  assert.ok(!/S\.branch = r\.branch;[\s\S]{0,200}enterApp\(\);/.test(verify));
});

test('logout works for a session that has no single client', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'routes/clientAuth.js'), 'utf8');
  const out = auth.slice(auth.indexOf("router.post('/logout'"));
  // req.client is undefined for a branch session by design, so reading .jti off it
  // threw for exactly the people with the most to sign out of.
  assert.ok(!/req\.client\.jti/.test(out.slice(0, 600)));
  assert.match(out, /const p = req\.portal \|\| \{\};/);
});
