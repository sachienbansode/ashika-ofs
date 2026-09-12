'use strict';
/**
 * Real codes or fixed ones — and who gets to decide.
 *
 * The desk asked to switch this from a screen instead of a deploy, which is right
 * for UAT and dangerous everywhere else. So there are three inputs with a strict
 * order of authority, and the top one is not reachable from any screen:
 *
 *   1. the app server's own environment — production refuses a fixed code outright
 *   2. the setting, written from Masters > Settings
 *   3. the .env flag, for a server whose setting has never been touched
 *
 * The failure this pins down is the silent one: a dropdown that says "test" on a
 * production server, doing nothing, while someone plans a UAT round against a code
 * that will never arrive.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const otp = require('../lib/otp');

const ENV = ['NODE_ENV', 'OFS_OTP_TEST_MODE', 'OFS_STAFF_OTP_TEST_MODE'];
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('production refuses a fixed code, whatever anyone sets', () => {
  withEnv({ NODE_ENV: 'production', OFS_OTP_TEST_MODE: 'true', OFS_STAFF_OTP_TEST_MODE: 'true' }, () => {
    // Every combination that could ask for one, refused.
    assert.equal(otp.testMode({ otp_mode_client: 'test' }), false);
    assert.equal(otp.staffTestMode({ otp_mode_staff: 'test' }), false);
    assert.equal(otp.testMode({}), false);
    assert.equal(otp.testMode(), false);
    assert.equal(otp.isProduction(), true);
  });
  // Case does not matter; a stray 'Production' must not open the door.
  withEnv({ NODE_ENV: 'Production' }, () => {
    assert.equal(otp.testMode({ otp_mode_client: 'test' }), false);
  });
});

test('off production, the setting decides — and beats the env flag', () => {
  withEnv({ NODE_ENV: 'uat', OFS_OTP_TEST_MODE: 'false' }, () => {
    assert.equal(otp.testMode({ otp_mode_client: 'test' }), true, 'the setting turns it on');
  });
  withEnv({ NODE_ENV: 'uat', OFS_OTP_TEST_MODE: 'true' }, () => {
    assert.equal(otp.testMode({ otp_mode_client: 'real' }), false, 'and the setting turns it off');
  });
  withEnv({ NODE_ENV: 'uat', OFS_STAFF_OTP_TEST_MODE: 'true' }, () => {
    assert.equal(otp.staffTestMode({ otp_mode_staff: 'real' }), false);
    assert.equal(otp.staffTestMode({ otp_mode_staff: 'test' }), true);
  });
});

test('blank, absent or rubbish falls back to the app server flag', () => {
  // This is what every existing deployment looks like: the setting has never been
  // touched, so behaviour must not change under them.
  for (const s of [{}, { otp_mode_client: '' }, { otp_mode_client: '   ' },
                   { otp_mode_client: 'yes' }, { otp_mode_client: null }, null]) {
    withEnv({ NODE_ENV: 'uat', OFS_OTP_TEST_MODE: 'true' }, () => {
      assert.equal(otp.testMode(s), true, JSON.stringify(s));
    });
    withEnv({ NODE_ENV: 'uat' }, () => {
      assert.equal(otp.testMode(s), false, 'unset flag means real codes: ' + JSON.stringify(s));
    });
  }
});

test('the two audiences never read each other\'s setting', () => {
  withEnv({ NODE_ENV: 'uat' }, () => {
    // Turning fixed codes on for clients must not put the back office — the door to
    // every client's PII and to the exchange files — on a shared password.
    assert.equal(otp.staffTestMode({ otp_mode_client: 'test' }), false);
    assert.equal(otp.testMode({ otp_mode_staff: 'test' }), false);
  });
});

test('the setting is offered, validated and explained in App Server terms', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
  for (const k of ['otp_mode_client', 'otp_mode_staff']) {
    assert.ok(src.includes(k + ': {'), k + ' is not editable');
  }
  // Only these three values, so a typo cannot quietly mean "test".
  assert.match(src, /\['', 'real', 'test'\]\.includes\(v\)/);
  // The screen talks about App Server Settings, never a filename: where a flag
  // lives is an operations question and the desk cannot act on a path anyway.
  assert.match(src, /App Server Settings/);
  assert.ok(!/\.env/.test(src), 'settings hints must not name .env');

  const app = fs.readFileSync(path.join(ROOT, 'public/backoffice/app.js'), 'utf8');
  assert.match(app, /function renderServerBanner\(sv\)/);
  assert.match(app, /App Server Settings/);
  assert.ok(!/\.env/.test(app.slice(app.indexOf('function renderServerBanner'),
                                     app.indexOf('async function loadSettings'))),
    'the banner must not name .env either');
});

test('the server verdict rides along with the settings, so the screen can show it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
  assert.match(src, /production: otp\.isProduction\(\)/);
  assert.match(src, /otp_client_effective: otp\.testMode\(current\)/);
  assert.match(src, /otp_staff_effective: otp\.staffTestMode\(current\)/);
});
