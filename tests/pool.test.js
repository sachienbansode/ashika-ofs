'use strict';
/**
 * Regression tests for db/pool.js config building — no database required.
 *
 * The bug these exist for: pg merges `connectionString` OVER the rest of the
 * config, so passing a URL plus a separate password silently dropped the password
 * and the server rejected SCRAM with "client password must be a string". pool.js
 * therefore expands the URL itself and never hands pg a connectionString.
 *
 * pgConfig.js holds the pure config building, so these run without a driver.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { build, fromUrl } = require('../db/pgConfig');   // no pg import needed

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); }
  finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('a URL is expanded, never passed through as connectionString', () => {
  const cfg = withEnv({ X_DATABASE_URL: 'postgresql://root_admin@198.51.100.9:5432/ofs_bids' },
    () => build('X', 'test'));
  assert.equal(cfg.connectionString, undefined, 'connectionString would clobber the password');
  assert.equal(cfg.host, '198.51.100.9');
  assert.equal(cfg.port, 5432);
  assert.equal(cfg.database, 'ofs_bids');
  assert.equal(cfg.user, 'root_admin');
});

test('a separately supplied password reaches the driver', () => {
  const cfg = withEnv({
    X_DATABASE_URL: 'postgresql://root_admin@198.51.100.9:5432/ofs_bids',
    X_PG_PASSWORD: 'p@ss word#1'
  }, () => build('X', 'test'));
  assert.equal(cfg.password, 'p@ss word#1');
});

test('a separate password overrides one embedded in the URL', () => {
  const cfg = withEnv({
    X_DATABASE_URL: 'postgresql://u:fromurl@h:5432/d',
    X_PG_PASSWORD: 'fromenv'
  }, () => build('X', 'test'));
  assert.equal(cfg.password, 'fromenv');
});

test('a password embedded in the URL still works, URL-decoded', () => {
  const cfg = withEnv({ X_DATABASE_URL: 'postgresql://u:a%40b%20c@h:5432/d' }, () => build('X', 'test'));
  assert.equal(cfg.password, 'a@b c');
});

test('no password at all leaves the key absent rather than undefined', () => {
  const cfg = withEnv({ X_DATABASE_URL: 'postgresql://u@h:5432/d' }, () => build('X', 'test'));
  assert.ok(!('password' in cfg), 'an undefined password confuses pg error reporting');
});

test('discrete vars work when no URL is given', () => {
  const cfg = withEnv({
    X_PG_HOST: '198.51.100.9', X_PG_PORT: '5432', X_PG_DATABASE: 'ofs_bids',
    X_PG_USER: 'root_admin', X_PG_PASSWORD: 'pw'
  }, () => build('X', 'test'));
  assert.equal(cfg.host, '198.51.100.9');
  assert.equal(cfg.database, 'ofs_bids');
  assert.equal(cfg.password, 'pw');
});

test('SSL follows the flag, and sslmode in the URL overrides it', () => {
  const on = withEnv({ X_DATABASE_URL: 'postgresql://u@h/d', X_PG_SSL: 'true' }, () => build('X', 'test'));
  assert.deepEqual(on.ssl, { rejectUnauthorized: false });
  const off = withEnv({ X_DATABASE_URL: 'postgresql://u@h/d', X_PG_SSL: 'false' }, () => build('X', 'test'));
  assert.equal(off.ssl, false);
  const disabled = withEnv({ X_DATABASE_URL: 'postgresql://u@h/d?sslmode=disable', X_PG_SSL: 'true' },
    () => build('X', 'test'));
  assert.equal(disabled.ssl, false);
  const verify = withEnv({ X_DATABASE_URL: 'postgresql://u@h/d?sslmode=verify-full' }, () => build('X', 'test'));
  assert.deepEqual(verify.ssl, { rejectUnauthorized: true });
});

test('fromUrl decodes a database name and user with special characters', () => {
  const cfg = fromUrl('postgresql://ofs%40app:x@h:5432/ofs%2Dbids', false, 5);
  assert.equal(cfg.user, 'ofs@app');
  assert.equal(cfg.database, 'ofs-bids');
});

/* ---------------------------------------------------------------------------
 * A connection failure has to name the connection.
 *
 * The desk could not sign in and the log said, in full, "Connection terminated
 * due to connection timeout". No host, no database, no clue which of the two the
 * app had failed to reach — and the address in every comment and document was by
 * then the OLD one, so the obvious next step was to test a host that no longer
 * mattered. The address lives in .env and nowhere else; the error now says which
 * one was tried, and that a change to it needs a restart to take effect.
 * ------------------------------------------------------------------------- */
test('a connection failure names the host, the database and the restart rule', async () => {
  const env = { X_PG_HOST: '198.51.100.9', X_PG_PORT: '5999', X_PG_DATABASE: 'demo_db',
                X_PG_USER: 'u', X_PG_PASSWORD: 'p' };
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    const { make } = require('../db/pool');
    const c = make('X', 'probe');
    let msg = '';
    try { await c.query('SELECT 1'); } catch (e) { msg = e.message; }
    await c.close().catch(() => {});
    assert.match(msg, /198\.51\.100\.9:5999\/demo_db/, 'which connection failed');
    assert.match(msg, /\[x ->/, 'which of the two pools');
    assert.match(msg, /needs a restart/, 'the trap: .env is read once, at startup');
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('no real database address is written into the repo', () => {
  // Every document said 13.233.106.37 long after it stopped being true, which is
  // how a dead host got tested while the live one sat in .env.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = ['README.md', 'REUSE.md', 'CLAUDE.md', 'db/pool.js', 'docs/DEPLOY_AZURE.md',
                 'db/migrations/001_ofs_schema.sql'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/\b13\.233\.106\.37\b/.test(src), f + ' still names the old database host');
  }
});

/* ---------------------------------------------------------------------------
 * Hold the connections, do not reopen them.
 *
 * The app is on Azure and both databases are on AWS, so every new connection is
 * a DNS lookup, a TCP handshake, a TLS handshake and SCRAM across the public
 * internet. At a 30-second idle timeout a quiet desk threw the pool away and paid
 * all of it again on the next click, and the outbound NAT in front of the VM
 * collected a socket per attempt — which shows up as intermittent "connection
 * timeout" against a database that answers a fresh process perfectly well.
 * ------------------------------------------------------------------------- */
test('the pool keeps its connections warm across a quiet spell', () => {
  const cfg = withEnv({ X_PG_HOST: 'h', X_PG_PORT: '5432', X_PG_DATABASE: 'd', X_PG_USER: 'u' },
    () => build('X', 'app'));
  assert.equal(cfg.keepAlive, true, 'without a keepalive the path goes cold behind the NAT');
  assert.ok(cfg.idleTimeoutMillis >= 300000,
    'reaping an idle connection after 30s means reconnecting all day');
  assert.ok(cfg.connectionTimeoutMillis >= 15000,
    'a cold cross-cloud connection needs more than ten seconds');
});

test('all three belong to the network, so all three are overridable', () => {
  const cfg = withEnv({ X_PG_HOST: 'h', X_PG_PORT: '5432', X_PG_DATABASE: 'd', X_PG_USER: 'u',
                        X_PG_IDLE_MS: '1000', X_PG_CONNECT_MS: '2000', X_PG_POOL_MAX: '25' },
    () => build('X', 'app'));
  assert.equal(cfg.idleTimeoutMillis, 1000);
  assert.equal(cfg.connectionTimeoutMillis, 2000);
  assert.equal(cfg.max, 25);
});
