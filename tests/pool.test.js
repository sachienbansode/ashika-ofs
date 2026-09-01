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
  const cfg = withEnv({ X_DATABASE_URL: 'postgresql://root_admin@13.233.106.37:5432/ofs_bids' },
    () => build('X', 'test'));
  assert.equal(cfg.connectionString, undefined, 'connectionString would clobber the password');
  assert.equal(cfg.host, '13.233.106.37');
  assert.equal(cfg.port, 5432);
  assert.equal(cfg.database, 'ofs_bids');
  assert.equal(cfg.user, 'root_admin');
});

test('a separately supplied password reaches the driver', () => {
  const cfg = withEnv({
    X_DATABASE_URL: 'postgresql://root_admin@13.233.106.37:5432/ofs_bids',
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
    X_PG_HOST: '13.233.106.37', X_PG_PORT: '5432', X_PG_DATABASE: 'ofs_bids',
    X_PG_USER: 'root_admin', X_PG_PASSWORD: 'pw'
  }, () => build('X', 'test'));
  assert.equal(cfg.host, '13.233.106.37');
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
