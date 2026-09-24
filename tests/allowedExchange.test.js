'use strict';
/**
 * "Which exchanges are we live on" — one answer, four places that ask.
 *
 * NSE e-OFS and the BSE OFS module are separate enablements. Either can be pending,
 * suspended, or simply not taken, and bidding on one we cannot upload to produces a
 * bid that sits in the book until somebody notices it was never in any file. So the
 * desk sets it once and everything obeys: validateBid on the server, and the bid
 * form on each of the three logins.
 *
 * The browser cannot call lib/domain, so the rule is written twice — once in
 * lib/domain and once in public/shared/bidmath. That is the dangerous kind of
 * duplication, so these tests run BOTH copies over the same inputs and compare.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const d = require('../lib/domain');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const browser = (() => {
  const ctx = vm.createContext({ Math, Number, String, isFinite });
  ctx.window = ctx;
  vm.runInContext(read('public/shared/bidmath.js'), ctx);
  return ctx.OFS_BIDMATH;
})();

const SETTINGS = ['NSE,BSE', 'BSE', 'NSE', 'BSE,NSE', '', 'junk', 'BOTH', undefined]
  .map((v) => ({ allowed_exchanges: v }));
const ISSUES = ['NSE', 'BSE', 'BOTH', '', undefined]
  .map((v) => ({ symbol: 'COALINDIA', exchange: v }));

test('the browser and the server agree on every combination', () => {
  for (const s of SETTINGS) {
    assert.deepEqual(browser.allowedExchanges(s), d.allowedExchanges(s),
      'allowedExchanges disagree for ' + JSON.stringify(s));
    for (const i of ISSUES) {
      assert.deepEqual(browser.exchangesFor(i, s), d.exchangesFor(i, s),
        'exchangesFor disagree for ' + JSON.stringify([i.exchange, s.allowed_exchanges]));
      assert.equal(browser.issueTradable(i, s), d.issueTradable(i, s));
      assert.equal(browser.notTradableMessage(i, s), d.notTradableMessage(i, s) || '',
        'the two would tell the client different things');
    }
  }
});

test('an unset or unreadable value means both — never "no trading"', () => {
  // A setting nobody has touched, or one a future build writes differently, must
  // not be the thing that silently stops the desk.
  for (const v of ['', null, undefined, 'junk', 'BOTH', 'nse bse', 0]) {
    assert.deepEqual(d.allowedExchanges({ allowed_exchanges: v }), ['NSE', 'BSE'], JSON.stringify(v));
  }
  assert.deepEqual(d.allowedExchanges(null), ['NSE', 'BSE']);
  assert.deepEqual(d.allowedExchanges({}), ['NSE', 'BSE']);
  // And the shipped default is both.
  assert.match(read('lib/settings.js'), /allowed_exchanges: process\.env\.OFS_ALLOWED_EXCHANGES \|\| 'NSE,BSE'/);
});

test('with one exchange enabled: both-listed offers still work, single-listed ones do not', () => {
  const bse = { allowed_exchanges: 'BSE' };
  assert.deepEqual(d.exchangesFor({ exchange: 'BOTH' }, bse), ['BSE'],
    'an offer on both exchanges goes to the one we are live on');
  assert.deepEqual(d.exchangesFor({ exchange: 'BSE' }, bse), ['BSE']);
  assert.deepEqual(d.exchangesFor({ exchange: 'NSE' }, bse), [],
    'an NSE-only offer cannot be bid on while only BSE is enabled');
  // The form's starting value follows, with no choice left to make.
  assert.equal(browser.defaultExchange({ exchange: 'BOTH' }, bse), 'BSE');
  assert.equal(browser.defaultExchange({ exchange: 'NSE' }, bse), '');
  const nse = { allowed_exchanges: 'NSE' };
  assert.equal(browser.defaultExchange({ exchange: 'BOTH' }, nse), 'NSE',
    'the same logic the other way round — not a hard-coded BSE');
  // Both enabled: BSE is the default, and the other is one click away.
  assert.equal(browser.defaultExchange({ exchange: 'BOTH' }, { allowed_exchanges: 'NSE,BSE' }), 'BSE');
});

/* --------------------------------------------------------------------------
 * The gate itself. A form can be bypassed; validateBid cannot.
 * ----------------------------------------------------------------------- */
const F = require('./fixtures');

function errsFor(issueExch, bidExch, allowed) {
  const issue = Object.assign({}, F.ISSUE, { exchange: issueExch });
  const bid = F.bid({ exchange: bidExch });
  const ctx = F.ctx({ settings: Object.assign({}, F.SETTINGS, { allowed_exchanges: allowed }) });
  return d.validateBid(issue, bid, ctx).filter((e) => /exchange|OFS desk|marked for/i.test(e));
}

test('the server refuses a bid to an exchange the desk is not live on', () => {
  assert.deepEqual(errsFor('BOTH', 'NSE', 'NSE,BSE'), [], 'both enabled: nothing to refuse');
  assert.deepEqual(errsFor('BOTH', 'BSE', 'BSE'), [], 'the enabled one is accepted');

  const refused = errsFor('BOTH', 'NSE', 'BSE');
  assert.equal(refused.length, 1, 'a bid to the disabled exchange must be refused');
  assert.match(refused[0], /not being accepted on NSE/);
  assert.ok(!/null|undefined|ofs_|schema/i.test(refused[0]), 'no internals in the message');

  // An offer listed only on the disabled exchange: refused whatever the bid says.
  for (const want of ['NSE', 'BSE', null]) {
    const e = errsFor('NSE', want, 'BSE');
    assert.ok(e.length, 'an NSE-only offer was accepted with only BSE enabled (bid said ' + want + ')');
  }
});

test('with one exchange enabled, a blank choice is filled in rather than refused as ambiguous', () => {
  // There is only one answer, so "choose one" would be a silly thing to say. The
  // message names it instead — and the FORM has already set it, so this is the
  // belt-and-braces path for a request that did not come from the form.
  const e = errsFor('BOTH', null, 'BSE');
  assert.equal(e.length, 1);
  assert.match(e[0], /must be marked for BSE/);
  // With both enabled the old wording stands: somebody really does have to choose.
  const both = errsFor('BOTH', null, 'NSE,BSE');
  assert.match(both[0], /Choose the exchange for this bid/);
});

/* --------------------------------------------------------------------------
 * The three screens.
 * ----------------------------------------------------------------------- */

test('the setting is editable, validated, and explained', () => {
  const src = read('routes/settings.js');
  assert.match(src, /allowed_exchanges: \{/);
  assert.match(src, /choices: \['NSE,BSE', 'BSE', 'NSE'\]/);
  // The hint has to say what it DOES, or nobody will dare touch it.
  assert.match(src, /shows only what is enabled/);
  assert.match(src, /Bids already placed are not changed/);
});

test('the desk form and the client portal both read the setting', () => {
  const app = read('public/backoffice/app.js');
  assert.match(app, /BIDMATH\.exchangesFor\(i, STATE\.settings\)/, 'the desk dropdown ignores it');
  assert.match(app, /BIDMATH\.issueTradable\(i, STATE\.settings\)/, 'the desk issue list ignores it');

  const client = read('public/client/client.js');
  assert.match(client, /OFS_BIDMATH\.exchangesFor\(i, SETTINGS\)/, 'the client dropdown ignores it');
  assert.match(client, /OFS_BIDMATH\.issueTradable\(i, SETTINGS\)/, 'the client screens ignore it');

  // And the portal has to be SENT it, or SETTINGS is empty and everything
  // silently falls back to "both enabled".
  assert.match(read('routes/clientPortal.js'), /allowed_exchanges: s\.allowed_exchanges/);
  // The desk gets it in the dashboard payload, which sends the whole settings row.
  assert.match(read('routes/dashboard.js'), /settings: s,/);
});

test('a client sees why an offer cannot be bid on, in the list and on the form', () => {
  const client = read('public/client/client.js');

  // In the LIST, where the investor is deciding: no button, and the reason in
  // its place. Finding out two clicks later, on an empty form, is worse.
  const row = client.slice(client.indexOf('function issueRow('), client.indexOf('function placePage('));
  assert.match(row, /notTradableMessage/, 'the row leaves the investor guessing');
  assert.ok(row.indexOf('issueTradable') < row.indexOf('data-place'),
    'the check must come before the button is offered');

  // And on the form itself, for anyone who reaches it by URL or by a stale tab.
  const page = client.slice(client.indexOf('function placePage('), client.indexOf('function openPlace('));
  assert.match(page, /notTradableMessage/, 'the form is built for an offer that cannot take it');
  assert.ok(page.indexOf('issueTradable') < page.indexOf('data-bid-issue'),
    'the check must come before the form is built');
});
