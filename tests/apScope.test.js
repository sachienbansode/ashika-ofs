'use strict';
/**
 * The branch / AP view: what it is scoped to, and what it is allowed to see.
 *
 * An AP is not the desk. Two things follow, and both are enforced on the server
 * because the screen is the same screen:
 *
 *   the WHERE clause is the branch's own client list, applied once rather than
 *   trusted to the page; and
 *   contact details are masked, because ld.enrich hands back pan, mobile and email
 *   raw and those rows also leave the building in a CSV.
 *
 * A CLIENT session is deliberately left unmasked — it is their own address, and
 * masking it back at them is noise.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'routes/clientPortal.js'), 'utf8');
const pii = require('../lib/pii');

function lift(name, ctx) {
  const m = new RegExp('function ' + name + '\\([\\s\\S]*?\\n}', 'm').exec(SRC);
  assert.ok(m, 'could not find ' + name + ' in clientPortal.js');
  vm.runInContext(m[0], ctx);
  return ctx;
}

const ROWS = [{ client_ucc: 'A12234', client_name: 'A CLIENT', pan: 'IQHPB9346B',
                mobile: '7586952243', email: 'someone@example.com', qty: 100 }];

function maskAs(kind) {
  const ctx = vm.createContext({ pii, Object });
  lift('maskPortalRows', ctx);
  return ctx.maskPortalRows({ portal: { kind } }, ROWS);
}

test('a branch or AP never sees a full PAN, mobile or email', () => {
  for (const kind of ['branch', 'ap']) {
    const [r] = maskAs(kind);
    assert.ok(!/IQHPB9346B/.test(r.pan), kind + ' saw a full PAN');
    assert.ok(!/7586952243/.test(r.mobile), kind + ' saw a full mobile');
    assert.ok(!/someone@example\.com/.test(r.email), kind + ' saw a full email');
    // Masked, not deleted: an AP still has to recognise which client a row is.
    assert.match(r.pan, /9346B$/);
    assert.match(r.mobile, /2243$/);
    assert.match(r.email, /@example\.com$/);
    assert.equal(r.client_name, 'A CLIENT', 'the name is not PII to the AP who owns the client');
    assert.equal(r.qty, 100, 'non-PII columns are untouched');
  }
});

test('a client sees their own contact details unmasked', () => {
  const [r] = maskAs('client');
  assert.equal(r.pan, 'IQHPB9346B');
  assert.equal(r.email, 'someone@example.com');
});

test('every row a branch receives goes through the mask', () => {
  // The failure mode is a new endpoint that forgets, so the rule is checked at the
  // source: any ld.enrich in this file must be wrapped, except the one guarded by
  // an explicit client-session check.
  const enrichCalls = SRC.match(/await ld\.enrich\([^)]*\)/g) || [];
  assert.ok(enrichCalls.length >= 2, 'expected the bid list and the dashboard to enrich');
  for (const call of enrichCalls) {
    const at = SRC.indexOf(call);
    const context = SRC.slice(Math.max(0, at - 220), at + call.length);
    assert.ok(/maskPortalRows\(/.test(context) || /kind === 'client'/.test(context),
      'unmasked enrich: ' + call);
  }
});

test('the dashboard is scoped to the branch, on every figure', () => {
  const block = SRC.slice(SRC.indexOf("router.get('/me/dashboard'"));
  const body = block.slice(0, block.indexOf('\n});'));
  // Four separate queries — issues, totals, all_live, recent. Every one of them
  // must carry the scope; one that does not is a leak of the whole book.
  const queries = body.match(/FROM \$\{SCHEMA\}\.ofs_bid/g) || [];
  assert.ok(queries.length >= 4, 'expected four bid queries, found ' + queries.length);
  const scoped = body.match(/client_ucc = ANY\(\$1\)/g) || [];
  assert.equal(scoped.length, queries.length,
    'every bid query must be scoped by the branch client list');
  assert.match(body, /const scope = await scopeUccs\(req\);/);
  assert.match(body, /if \(!scope\.length\) return res\.json\(empty\);/,
    'no clients means no rows, never every row');
});

test('the dashboard answers with the desk’s own shape', () => {
  // The point of this endpoint is that the back-office renderer can consume it
  // unchanged. If a key is renamed here the AP dashboard silently shows blanks.
  const block = SRC.slice(SRC.indexOf("router.get('/me/dashboard'"));
  for (const key of ['server_time', 'scope', 'as_on', 'settings', 'market',
                     'issues', 'totals', 'all_live', 'recent']) {
    assert.ok(new RegExp('\\b' + key + ':').test(block.slice(0, 4000)), 'missing key: ' + key);
  }
  for (const key of ['status_label', 'hni_status', 'ret_status', 'open_on_scope',
                     'min_price_retail', 'our_vwap']) {
    assert.ok(block.includes(key + ':'), 'issue rows must carry ' + key);
  }
});

test('subscription is not reported against a branch’s own book', () => {
  // Subscription is bids-against-issue-size for the WHOLE offer. A branch's share
  // of it is not a subscription figure, and printing one would be a number that
  // looks authoritative and means nothing.
  const block = SRC.slice(SRC.indexOf("router.get('/me/dashboard'"));
  assert.match(block, /subscription_x: null/);
});

test('my clients is paged on the server', () => {
  const block = SRC.slice(SRC.indexOf("router.get('/me/clients'"));
  const body = block.slice(0, block.indexOf('\n});'));
  assert.match(body, /const limit = Math\.min\(Math\.max\(Number\(req\.query\.limit\) \|\| 10/);
  assert.match(body, /list\.slice\(offset, offset \+ limit\)/);
  assert.match(body, /total,/, 'the client needs the full count to build a pager');
  // all=1 stays, because a CSV of ten rows is not a CSV.
  assert.match(body, /req\.query\.all/);
});

/**
 * The client portal is the CLIENT's, and nobody else's.
 *
 * It used to serve a branch as well, switching a tab on, adding a UCC field to the
 * bid box and flipping the endpoint — a client portal wearing extra clothes. Once
 * branches moved to /partner that became a second, unreachable implementation of
 * the same screens, and two implementations of one thing is the drift this whole
 * change was meant to avoid. So it is gone, and this is what keeps it gone.
 *
 * The branch DOOR is not part of that: a branch still signs in on this page, and
 * verifyBranchCode sends them to /partner once they have.
 */
test('no branch shell survives in the client portal', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/client/client.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public/client/index.html'), 'utf8');

  // Every fork that made this screen behave as two different products.
  assert.ok(!/S\.branch/.test(app), 'a session-kind fork is still switching this shell');
  assert.ok(!/loadClients\(/.test(app), 'the clients list is still here');
  assert.ok(!/data-bidfor=/.test(app), 'the clients table is still here');
  assert.ok(!/branch\/bids/.test(app), 'the branch bid endpoint is still reachable from here');
  assert.ok(!/tabClients|cpane-clients/.test(html), 'the tab or its pane is still in the page');

  // One session, one endpoint — and the UCC is never in the body, which is what
  // stops a client bidding on another account by editing a request.
  assert.match(app, /function bidBase\(\) \{ return '\/client\/api\/bids'; \}/);
  assert.ok(!/body\.client_ucc =/.test(app));
});

test('the branch door stays, and leads to the partner shell', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/client/client.js'), 'utf8');
  // Removing the branch SHELL must not remove the branch SIGN-IN.
  assert.match(app, /function sendBranchCode\(/);
  assert.match(app, /function verifyBranchCode\(/);
  assert.match(app, /location\.href = '\/partner\/';/);
});
