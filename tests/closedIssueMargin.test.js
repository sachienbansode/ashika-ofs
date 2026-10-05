'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const scope = require('../lib/bidScope');
const { catStatus } = require('../lib/domain');

const S = { daily_cutoff: '15:15' };
const NOW = new Date('2026-10-05T08:51:00Z');            // 14:21 IST
const issue = (over) => Object.assign({
  status: 'Auto',
  ret_open: '2026-10-05T03:45:00Z', ret_close: '2026-10-06T09:45:00Z',
  hni_open: '2026-10-05T03:45:00Z', hni_close: '2026-10-05T09:45:00Z'
}, over);
const bid = (over) => Object.assign({ status: 'Live', category: 'Retail' }, over);

/* ---------------------------------------------------------------------------
 * "Closed issues are also shown as LIVE, it's also affecting the available
 * margin calculation."
 *
 * ofs_bid.status records what the CLIENT did — placed, modified, withdrew. The
 * offer closing is not something anybody types, so nothing ever moved a bid off
 * 'Live'. A bid on an offer that finished last week therefore read LIVE on every
 * screen for ever, and — the expensive half — went on holding the client's margin,
 * so a client could be refused today's bid against margin released days ago.
 * ------------------------------------------------------------------------- */

test('a bid on an offer that has closed is not live any more', () => {
  const old = issue({ ret_close: '2026-09-29T09:45:00Z' });
  assert.equal(scope.isWorking(bid(), old, NOW, S), false);
  assert.equal(scope.statusLabel(bid(), old, NOW, S), 'Closed');
});

test('a bid on an offer still taking bids is', () => {
  assert.equal(scope.isWorking(bid(), issue(), NOW, S), true);
  assert.equal(scope.statusLabel(bid(), issue(), NOW, S), 'Live');
});

test('the desk closing an offer closes its bids with it, window or no window', () => {
  const shut = issue({ status: 'Closed', ret_close: '2026-10-20T09:45:00Z' });
  assert.equal(scope.isWorking(bid(), shut, NOW, S), false);
  // Withdrawn has been a legal issue status since the undisclosed-floor change and
  // was read nowhere, so a withdrawn offer went on reading Open and taking bids.
  assert.equal(catStatus(issue({ status: 'Withdrawn' }), 'Retail', NOW, S), 'Closed');
});

test('each category answers for its own window', () => {
  // HNI closed yesterday evening, Retail runs to tomorrow.
  const i = issue({ hni_close: '2026-10-04T09:45:00Z' });
  assert.equal(scope.isWorking(bid({ category: 'HNI' }), i, NOW, S), false);
  assert.equal(scope.isWorking(bid({ category: 'Retail' }), i, NOW, S), true);
});

test('what the client did to the bid still wins', () => {
  for (const st of ['Cancelled', 'Rejected']) {
    assert.equal(scope.isWorking(bid({ status: st }), issue(), NOW, S), false);
    assert.equal(scope.statusLabel(bid({ status: st }), issue(), NOW, S), st,
      'a withdrawn bid must not be relabelled Closed — they are different facts');
  }
});

/* The SQL half. It is the same rule, and it is the one that cannot be checked by
 * reading a row, so what it must contain is pinned here. Verified against a real
 * PostgreSQL with the server in UTC: the issue sets the day, the cut-off the hour. */
test('the predicate names the zone at every step, not the server default', () => {
  const sql = scope.workingSql(2);
  assert.equal((sql.match(/Asia\/Kolkata/g) || []).length, 2,
    'the date and the result both have to be in IST — the server runs UTC, where ' +
    'anything before 05:30 IST falls on the previous day');
  assert.match(sql, /\$2::time/, 'the cut-off is a parameter, never interpolated');
  assert.match(sql, /CASE WHEN b\.category = 'HNI' THEN i\.hni_close ELSE i\.ret_close END/);
  assert.match(sql, /i\.status NOT IN \('Closed', 'Withdrawn'\)/);
});

test('the cut-off that reaches the predicate is a real time of day', () => {
  assert.equal(scope.cutoffOf({ daily_cutoff: '19:15' }), '19:15');
  for (const bad of [null, undefined, '', '25:00', 'drop table', '9:5']) {
    assert.equal(scope.cutoffOf({ daily_cutoff: bad }), '15:15',
      'a bad setting falls back to the session close, it does not reach SQL');
  }
});

test('every margin total is the working one — all five of them', () => {
  const svc = read('lib', 'bidService.js');
  assert.equal((svc.match(/scope\.workingSql\(2\)/g) || []).length, 2,
    'the context load AND the locked re-check');
  const view = read('lib', 'marginView.js');
  assert.match(view, /scope\.workingSql\(2\)/, 'the margin every login reads');
  const route = read('routes', 'margin.js');
  assert.equal((route.match(/scope\.workingSql\(/g) || []).length, 2,
    'the desk margin list, and the guard that refuses to delete margin under a bid');
  // Nothing may go back to summing every row that was ever placed.
  for (const [name, src] of [['marginView', view], ['margin route', route]]) {
    assert.ok(!/WHERE status = 'Live' GROUP BY client_ucc/.test(src),
      name + ' still has the old unjoined total');
  }
});

test('the status chip reads the label the server sends, on all three front ends', () => {
  const desk = read('public', 'backoffice', 'app.js');
  assert.match(desk, /function bidStatus\(b\) \{ return \(b && \(b\.status_label \|\| b\.status\)\)/);
  assert.ok(!/statusCls\(b\.status\)/.test(desk), 'a raw b.status is a row that can say LIVE');
  const client = read('public', 'client', 'client.js');
  assert.match(client, /function bidStatus\(x\) \{ return \(x && \(x\.status_label \|\| x\.status\)\)/);
  // ...and the label has to be sent, or the front ends fall back to the old answer.
  assert.match(read('routes', 'bids.js'), /bidScope\.decorate\(/);
  assert.match(read('routes', 'clientPortal.js'), /bidScope\.decorate\(/);
});

test('the issue status is aliased, or it lands on the row over the bid status', () => {
  for (const f of [['routes', 'bids.js'], ['routes', 'clientPortal.js']]) {
    assert.match(read(...f), /i\.status AS issue_status/, f.join('/'));
  }
  // and bidScope reads the alias, never row.status
  assert.match(read('lib', 'bidScope.js'), /status: row\.issue_status \|\| 'Auto'/);
});
