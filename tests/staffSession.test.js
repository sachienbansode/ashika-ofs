'use strict';
/**
 * The back-office session is OFS's own.
 *
 * What this replaced: OFS and the Stage API portal both rotated
 * "admin-staging-api".users.active_sid — one column, two applications — so signing
 * in to either ended the other. Users experienced that as being logged out at
 * random. These tests pin the rules of the replacement; the SQL behind them
 * (idle, supersede, expiry) was verified against PostgreSQL 16 separately.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('idle timeout defaults to 30 minutes and rejects nonsense', () => {
  const ss = require('../lib/staffSession');
  const before = process.env.OFS_STAFF_IDLE_MIN;
  try {
    delete process.env.OFS_STAFF_IDLE_MIN;
    assert.equal(ss.idleMinutes(), 30);
    process.env.OFS_STAFF_IDLE_MIN = '45';
    assert.equal(ss.idleMinutes(), 45);
    for (const bad of ['0', '-5', 'soon', '']) {
      process.env.OFS_STAFF_IDLE_MIN = bad;
      assert.equal(ss.idleMinutes(), 30, bad + ' should fall back, not disable the timeout');
    }
  } finally {
    if (before === undefined) delete process.env.OFS_STAFF_IDLE_MIN;
    else process.env.OFS_STAFF_IDLE_MIN = before;
  }
});

test('no code still reads or writes users.active_sid', () => {
  // The whole point. A helpful re-add of this check would silently restore the bug,
  // and the symptom (logged out of the other app) looks nothing like its cause.
  for (const f of ['middleware/auth.js', 'routes/auth.js', 'routes/staffAuth.js', 'lib/sso.js']) {
    const src = read(f);
    const code = src.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))     // comments explain the history
      .join('\n');
    assert.ok(!/active_sid/.test(code), f + ' still touches users.active_sid');
  }
});

test('the session check names every way a session can end', () => {
  const src = read('lib/staffSession.js');
  for (const reason of ['no_session', 'session_unknown', 'session_revoked',
                        'session_expired', 'session_idle']) {
    assert.ok(src.includes("'" + reason + "'"), 'staffSession never returns ' + reason);
  }
});

test('every reason the server can send has a sentence on the login page', () => {
  const login = read('public/backoffice/login.js');
  const app = read('public/backoffice/app.js');
  for (const r of ['superseded', 'idle', 'expired', 'revoked']) {
    assert.ok(new RegExp('\\b' + r + ':').test(login) || login.includes("'" + r + "'"),
      'login.js has no message for reason=' + r);
    assert.ok(app.includes("'" + r + "'"), 'app.js never sends reason=' + r);
  }
});

test('a token minted before this change is refused, not waved through', () => {
  // It carries no jti, so check(undefined) must fail closed.
  const src = read('lib/staffSession.js');
  assert.match(src, /if \(!jti\) return 'no_session'/);
});

test('the migration creates the table and both indexes', () => {
  const sql = read('db/migrations/016_ofs_staff_session.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ofs\.ofs_staff_session/);
  assert.match(sql, /ofs_staff_session_user_ix/);
  assert.match(sql, /ofs_staff_session_live_ix/);
  assert.match(sql, /last_seen_at/);
});
