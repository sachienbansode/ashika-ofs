'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const domain = require('../lib/domain');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP = read('public', 'backoffice', 'app.js');
const CLIENT = read('public', 'client', 'client.js');

const fn = (src, name, len) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' is gone');
  return src.slice(i, i + (len || 3000));
};

/* An offer that opens Thursday morning and, on the master, runs to Friday 17:15. */
const ISSUE = {
  symbol: 'COALINDIA', status: 'Open',
  hni_open: '2026-09-24T09:15:00+05:30', hni_close: '2026-09-25T17:15:00+05:30',
  ret_open: '2026-09-24T09:15:00+05:30', ret_close: '2026-09-25T17:15:00+05:30'
};
const S = { daily_cutoff: '15:15', market_open: '09:15', market_close: '15:30', market_days: '1-5' };
const at = (s) => new Date(s + '+05:30');
const ist = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
}).format(d);

/* ---------------------------------------------------------------------------
 * The screen showed the issue master's 05:15 PM beside a refusal naming 15:15,
 * and nothing said which of the two governed. validateBid always applied both —
 * catStatus to the offer's own days, marketState to today — so the gate was
 * right and the panel was the thing telling the desk a time it would not be held
 * to.
 * ------------------------------------------------------------------------- */

test('the enforced close is the offer’s day at the desk cut-off', () => {
  const w = domain.effectiveWin(ISSUE, 'Retail', S);
  assert.equal(ist(w.close), '25/09/2026, 15:15',
    'the close still carries the hour typed on the issue master');
});

test('bidding stops at the cut-off on a day BEFORE the offer closes', () => {
  // Thursday, with the offer running to Friday. The old code had nothing to say
  // here at all: effectiveWin answers Friday 15:15, so the panel printed a time
  // 24 hours away while the desk stopped in ten minutes.
  const stop = domain.stopsToday(ISSUE, 'Retail', at('2026-09-24T14:00:00'), S);
  assert.equal(ist(stop), '24/09/2026, 15:15', 'today’s stop is not today');
});

test('on the closing day, today’s stop and the offer’s close are the same moment', () => {
  const stop = domain.stopsToday(ISSUE, 'Retail', at('2026-09-25T10:00:00'), S);
  const close = domain.effectiveWin(ISSUE, 'Retail', S).close;
  assert.equal(stop.getTime(), close.getTime());
});

test('once the offer is over there is no “today” left for it', () => {
  assert.equal(domain.stopsToday(ISSUE, 'Retail', at('2026-09-26T10:00:00'), S), null);
});

test('raising the cut-off moves today’s stop with it', () => {
  const late = Object.assign({}, S, { daily_cutoff: '18:00' });
  assert.equal(ist(domain.stopsToday(ISSUE, 'Retail', at('2026-09-24T16:58:00'), late)),
    '24/09/2026, 18:00');
  // …and the bid gate agrees, which is the whole point of one setting read twice.
  assert.equal(domain.marketState(late, at('2026-09-24T16:58:00')).open, true);
  assert.equal(domain.marketState(S, at('2026-09-24T16:58:00')).open, false);
});

test('the 16:58 case from the screen: open offer, shut desk', () => {
  const now = at('2026-09-24T16:58:00');
  // The offer genuinely is open — it runs to tomorrow.
  assert.equal(domain.catStatus(ISSUE, 'Retail', now, S), 'Open');
  // And the desk genuinely has stopped. Both true; the screen showed only one.
  const mkt = domain.marketState(S, now);
  assert.equal(mkt.open, false);
  assert.equal(mkt.reason, 'after_cutoff');
  assert.match(domain.closedMessage(mkt), /desk cut-off of 15:15 IST has passed/);
});

test('every issue payload carries the enforced close and today’s stop', () => {
  const f = domain.windowFields(ISSUE, at('2026-09-24T14:00:00'), S);
  assert.equal(ist(new Date(f.ret_close_eff)), '25/09/2026, 15:15');
  assert.equal(ist(new Date(f.hni_close_eff)), '25/09/2026, 15:15');
  assert.equal(ist(new Date(f.ret_stops_today)), '24/09/2026, 15:15');
  assert.equal(f.daily_cutoff, '15:15');
});

test('windowFields is computed once, not four times in four routes', () => {
  for (const r of ['routes/issues.js', 'routes/dashboard.js']) {
    assert.match(read(...r.split('/')), /windowFields\(/, r + ' sends no enforced close');
  }
  const portal = read('routes', 'clientPortal.js');
  assert.equal(portal.split('windowFields(i, now, s)').length - 1, 2,
    'the portal has two issue lists and only one of them was updated');
});

/* ------------------------------------------------------------------ screens */

test('the desk prints the enforced close, not the typed one', () => {
  assert.match(APP, /function closeOf\(i, cat\)/);
  const f = fn(APP, 'closeOf', 400);
  assert.match(f, /i\.hni_close_eff \|\| i\.hni_close/, 'no fallback for an older payload');
  const panel = fn(APP, 'renderIssueInfo', 4000);
  assert.match(panel, /windowCell\(i\.hni_open, closeOf\(i, 'HNI'\)\)/);
  assert.match(panel, /windowCell\(i\.ret_open, closeOf\(i, 'Retail'\)\)/);
  assert.ok(!/windowCell\(i\.ret_open, i\.ret_close\)/.test(panel),
    'the panel still quotes the issue master’s own time');
});

test('the issue dropdown quotes the enforced close too', () => {
  const f = fn(APP, 'issueOptionLabel', 1600);
  assert.match(f, /\{ w: 'Retail', t: closeOf\(i, 'Retail'\) \}/);
  assert.ok(!/\{ w: 'Retail', t: i\.ret_close \}/.test(f),
    'the first thing the desk reads is still the typed time');
});

test('the panel now says when bidding stops, and why it has', () => {
  assert.match(APP, /function cutoffNote\(i\)/);
  const f = fn(APP, 'cutoffNote', 2000);
  assert.match(f, /Bidding stops at <b>' \+ esc\(cut\)/, 'the daily cut-off is still unsaid');
  assert.match(f, /esc\(m\.message \|\| /,
    'the panel writes its own reason instead of reusing the refusal’s words');
  assert.match(f, /if \(!stopsToday\(i, 'Retail'\) && !stopsToday\(i, 'HNI'\)\) return '';/,
    'a finished offer still gets a note about today');
  assert.match(fn(APP, 'renderIssueInfo', 4000), /cutoffNote\(i\)/, 'the note is never rendered');
});

test('the status chip stops reading as “you may bid now”', () => {
  const f = fn(APP, 'renderIssueInfo', 4000);
  assert.match(f, /marketShut\(\) \? '<span class="chip closed">shut for today<\/span>' : ''/,
    'an open chip still sits beside a refusal with nothing to reconcile them');
});

test('the investor portal reads the same field', () => {
  assert.match(CLIENT, /function closeOf\(i, cat\)/);
  assert.match(CLIENT, /function stopsToday\(i, cat\)/);
  const row = fn(CLIENT, 'issueRow', 1500);
  assert.match(row, /closeOf\(i, 'Retail'\)/, 'the list still prints the typed close');
  const page = fn(CLIENT, 'placePage', 4000);
  assert.match(page, /dt\(closeOf\(i, retOpen \? 'Retail' : 'HNI'\)\)/,
    'the Place bid page still prints the typed close');
  const strip = fn(CLIENT, 'showCutoff', 1400);
  assert.match(strip, /\[closeOf\(i, 'Retail'\), closeOf\(i, 'HNI'\)\]/,
    'the countdown strip still counts to a time the cut-off overrules');
});
