'use strict';
/**
 * Database rejections, translated. Every constraint named here exists in
 * db/migrations; if one is renamed and this map is not updated, the desk goes back
 * to seeing "server_error" for its own typo, so these tests are the reminder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const dbErr = require('../lib/dbErrors');

test('a duplicate issue names the clash and what to do about it', () => {
  const t = dbErr.translate({ code: '23505', constraint: 'ofs_issue_uq' });
  assert.equal(t.status, 409);
  assert.equal(t.field, 'symbol');
  assert.match(t.message, /already exists for that trading day/);
});

test('a window check names the windows, not the constraint', () => {
  const t = dbErr.translate({ code: '23514', constraint: 'ofs_issue_win_ck' });
  assert.equal(t.status, 422);
  assert.match(t.message, /close after it opens/);
  assert.ok(!/_ck/.test(t.message), 'the constraint name must not reach the desk');
});

test('a second live bid for one client on one issue is explained, not just refused', () => {
  const t = dbErr.translate({ code: '23505', constraint: 'ofs_bid_one_live_uq' });
  assert.match(t.message, /Modify that bid/);
});

test('a NOT NULL violation names the column in the words the form uses', () => {
  const t = dbErr.translate({ code: '23502', column: 'floor_price' });
  assert.equal(t.status, 400);
  assert.equal(t.message, 'Floor price is required.');
});

test('an unknown constraint still says something useful rather than nothing', () => {
  const t = dbErr.translate({ code: '23514', constraint: 'something_new_ck' });
  assert.equal(t.status, 422);
  assert.match(t.message, /something_new_ck/);
});

test('an error we caused is left alone, so a 500 stays a 500', () => {
  assert.equal(dbErr.translate({ code: '42P01', message: 'relation does not exist' }), null);
  assert.equal(dbErr.translate(new Error('boom')), null);
  assert.equal(dbErr.translate(null), null);
});

test('send() passes a non-database error onward untouched', () => {
  let handed = null;
  const res = { status() { throw new Error('should not respond'); } };
  dbErr.send(res, (e) => { handed = e; }, { code: '42P01' });
  assert.ok(handed);
});

test('every constraint in the map still exists in the migrations', () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const name of Object.keys(dbErr.CONSTRAINTS)) {
    assert.ok(sql.includes(name), name + ' is in the message map but not in any migration');
  }
});
