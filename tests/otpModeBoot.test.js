'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const otp = require('../lib/otp');

/* ---------------------------------------------------------------------------
 * "Still in test mode, why??"
 *
 * .env said NODE_ENV=production and OFS_STAFF_OTP_TEST_MODE=false. The live desk
 * went on printing 123456. The answer was in three places at once and the box
 * said none of them:
 *
 *   - dotenv does not overwrite what is already in process.env, and PM2 replays
 *     the environment it captured when the app was FIRST started. A shell that
 *     carried NODE_ENV=dev months ago kept winning, and editing .env could not
 *     dislodge it.
 *   - failing that, Masters > Settings can hold otp_mode_staff=test from UAT,
 *     which outranks the .env flag everywhere except production.
 * ------------------------------------------------------------------------- */

test('.env actually wins, which is what ecosystem.config.js already promises', () => {
  assert.match(read('server.js'), /require\('dotenv'\)\.config\(\{ override: true \}\)/,
    'without override, a stale PM2 environment beats the file the operator edits');
  assert.match(read('ecosystem.config.js'), /NODE_ENV deliberately NOT set here/);
});

test('production refuses a fixed code whatever else is set', () => {
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(otp.staffTestMode({ otp_mode_staff: 'test' }), false);
    assert.equal(otp.testMode({ otp_mode_client: 'test' }), false);
    assert.match(otp.explainMode({ otp_mode_staff: 'test' }, 'otp_mode_staff', 'OFS_STAFF_OTP_TEST_MODE'),
      /REAL codes \(NODE_ENV=production/);
  } finally { if (was === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = was; }
});

test('the boot log names which of the three inputs decided it', () => {
  const was = { e: process.env.NODE_ENV, f: process.env.OFS_STAFF_OTP_TEST_MODE };
  process.env.NODE_ENV = 'dev';
  process.env.OFS_STAFF_OTP_TEST_MODE = 'false';
  try {
    // the setting outranks the flag off production — this is the case that bit
    assert.match(otp.explainMode({ otp_mode_staff: 'test' }, 'otp_mode_staff', 'OFS_STAFF_OTP_TEST_MODE'),
      /FIXED code \(Settings otp_mode_staff=test; NODE_ENV=dev\)/);
    assert.match(otp.explainMode({}, 'otp_mode_staff', 'OFS_STAFF_OTP_TEST_MODE'),
      /REAL codes \(OFS_STAFF_OTP_TEST_MODE=false; NODE_ENV=dev\)/);
  } finally {
    if (was.e === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = was.e;
    if (was.f === undefined) delete process.env.OFS_STAFF_OTP_TEST_MODE;
    else process.env.OFS_STAFF_OTP_TEST_MODE = was.f;
  }
  // and it is printed for BOTH doors on every boot
  const srv = read('server.js');
  assert.match(srv, /\[boot\] client OTP :/);
  assert.match(srv, /\[boot\] staff OTP  :/);
});

test('the portal link is shown only when it can be used', () => {
  // It pointed at the UAT host on a live box, and when nothing was configured the
  // block kept its sentence with no link beside it.
  const js = read('public', 'backoffice', 'login.js');
  assert.match(js, /show\(\$\('#portalAlt'\), false\);/);
  assert.match(read('public', 'backoffice', 'login.html'), /class="lg-alt" id="portalAlt"/);
});
