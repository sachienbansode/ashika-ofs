'use strict';
/**
 * Two facts the dashboard card kept confusing with each other.
 *
 * An issue's window and the desk's trading day are not the same gate. COALINDIA's
 * Retail window ran to 15-Sep; at 18:02 on the 12th, with a desk cut-off of 15:15,
 * the card still offered "Bid on this issue" — the window was genuinely open, the
 * desk was shut, and the only way to discover that was to fill in the whole form
 * and be refused on submit. So:
 *
 *   - isBiddable answers "is this issue live", and the open-issues KPI depends on
 *     it still saying yes after the cut-off. It must NOT learn about the session.
 *   - canBidNow answers "may I act on it right now", which is the question the
 *     button is asking, and that one is gated by both.
 *
 * And the countdown: "69:12:27" is not a duration a person reads, nor one a desk
 * can repeat to a client.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/backoffice/app.js'), 'utf8');

/** Pull one function out of app.js and run the shipped code, not a copy of it. */
function lift(names, ctx) {
  for (const name of names) {
    const m = new RegExp('function ' + name + '\\([\\s\\S]*?\\n}', 'm').exec(SRC);
    assert.ok(m, 'could not find ' + name + ' in app.js');
    vm.runInContext(m[0], ctx);
  }
  return ctx;
}

function ctxWith(market) {
  const ctx = vm.createContext({ STATE: { market } });
  return lift(['isBiddable', 'marketShut', 'canBidNow', 'timeLeft'], ctx);
}

const OPEN_RETAIL = { status: 'Auto', ret_status: 'Open', hni_status: 'Closed' };
const UPCOMING = { status: 'Auto', ret_status: 'Upcoming', hni_status: 'Closed' };
const SHUT = { open: false, reason: 'after_cutoff', effective_close: '15:15',
  message: 'The desk cut-off of 15:15 IST has passed. No further bids are accepted today.' };

test('the open-issues count does not change at the desk cut-off', () => {
  // The issue is open until the 15th whatever the clock says today. If the session
  // leaked into isBiddable, the dashboard would report 0 open issues every evening.
  assert.equal(ctxWith(null).isBiddable(OPEN_RETAIL), true);
  assert.equal(ctxWith(SHUT).isBiddable(OPEN_RETAIL), true);
});

test('the bid button closes at the desk cut-off, and says why', () => {
  assert.equal(ctxWith({ open: true }).canBidNow(OPEN_RETAIL), true);
  assert.equal(ctxWith(SHUT).canBidNow(OPEN_RETAIL), false,
    'the window is open but the desk is shut — this is the case that shipped broken');
  assert.equal(ctxWith(null).canBidNow(OPEN_RETAIL), true, 'no verdict yet is not a closure');

  // A window that has not opened is not biddable now either, however open the desk.
  assert.equal(ctxWith({ open: true }).canBidNow(UPCOMING), false);
  assert.equal(ctxWith({ open: true }).canBidNow({ status: 'Suspended', ret_status: 'Open' }), false);
});

test('time left reads the way a person would say it', () => {
  const t = ctxWith(null).timeLeft;
  const h = (n) => n * 3600 * 1000;

  // The case on the screenshot: 69 hours, printed as 69:12:27.
  assert.equal(t(h(69) + 12 * 60000 + 27000).text, '2d 21h 12m');
  assert.equal(t(h(3) + 4 * 60000 + 5000).text, '3h 04m 05s');
  assert.equal(t(90 * 1000).text, '01:30');
  assert.equal(t(0).text, 'closed');
  assert.equal(t(-5000).urgency, 'over');

  // Urgency is what colours the card, so the thresholds are worth pinning.
  assert.equal(t(h(48)).urgency, 'calm');
  assert.equal(t(30 * 60000).urgency, 'soon');      // within the hour
  assert.equal(t(10 * 60000).urgency, 'urgent');    // within fifteen minutes
  assert.equal(t(15 * 60000).urgency, 'urgent', 'the boundary counts as urgent');
});

test('the card and the jump both honour the closure, not just the button', () => {
  // A disabled button is a suggestion; the keyboard, a stale card and a second tab
  // all reach bidOnIssue directly.
  assert.match(SRC, /function bidOnIssue\(id\) \{[\s\S]{0,400}?var shut = marketShut\(\);/,
    'bidOnIssue refuses before it switches tab');
  assert.match(SRC, /var canBid = canBidNow\(i\);/, 'the card asks the right question');
  assert.ok(!/var biddable = isBiddable\(i\);/.test(SRC),
    'the old, session-blind gate is gone from the card');
});

test('the server is what decides the session, not the browser clock', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'routes/dashboard.js'), 'utf8');
  assert.match(dash, /marketState, closedMessage/, 'the verdict comes from lib/marketHours');
  assert.match(dash, /market: Object\.assign\(\{\}, marketStateNow\(s, now\)/,
    'and rides along with the dashboard payload');
  assert.match(SRC, /STATE\.market = d\.market \|\| null;/);
  // The desk's cut-off is an IST rule; the machine reading the screen may be on
  // any zone, so the browser must never work this out for itself.
  assert.ok(!/getTimezoneOffset|new Date\(\)\.getHours\(\)/.test(SRC),
    'no local-clock trading decisions in the front end');
});
