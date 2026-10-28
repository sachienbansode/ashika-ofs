'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const SMS = read('lib', 'sms.js');
const sms = require('../lib/sms');

/* ---------------------------------------------------------------------------
 * SMS, the same way the platform already does it.
 *
 * The portal talks to the ACL / Sinch TextListener and keeps its credentials,
 * sender header, DLT template and fallback gateway in app_settings — in the same
 * database OFS already reads for staff accounts and SMTP. OFS reads that row
 * rather than holding a second copy, so changing the gateway on the portal's
 * Settings page changes it here too, with nothing to keep in step.
 * ------------------------------------------------------------------------- */

test('the gateway settings are the platform’s, not a second copy', () => {
  assert.match(SMS, /FROM "\$\{SCHEMA\}"\.app_settings WHERE id = 1/);
  assert.match(SMS, /sms_fb_base_url/, 'the fallback gateway comes from the same row');
  assert.match(SMS, /sms_otp_template_id/);
  assert.ok(!/OFS_SMS_APPID|OFS_SMS_PASS/.test(SMS), 'OFS must not hold its own credentials');
});

test('HTTP 200 is not success — the gateway answers in the body', () => {
  // ACL returns a number: positive is a message id, 0 or negative a refusal.
  // -1 credentials, -2 parameters, -3 sender ID / DLT template / IP not allowed,
  // every one of them with a cheerful HTTP 200.
  const ok = (body, fail) => sms.gatewayOk({ httpOk: true, statusCode: 200, body }, fail);
  assert.equal(ok('1234567890'), true, 'a message id is an accept');
  assert.equal(ok('-3'), false, 'the commonest refusal of all');
  assert.equal(ok('-1'), false);
  assert.equal(ok('0'), false);
  assert.equal(sms.gatewayOk({ httpOk: false, statusCode: 500, body: '1' }), false);
  assert.equal(ok('OK but ERROR inside', 'ERROR|INVALID'), false, 'the configured substring guard');
});

test('the URL encodes a space as %20, never +', () => {
  // URLSearchParams writes '+', which ACL takes literally, so the text stops
  // matching the registered DLT template and the send is refused.
  const url = sms.buildUrl({ base_url: 'https://x/t', appid: 'A', user_id: 'U', pass: 'p', header: 'ASHIKA' },
    { to: '919820012345', text: 'Hi, 1 is the OTP', templateId: '170716' });
  assert.ok(url.includes('%20'), 'spaces must be %20');
  assert.ok(!/text=[^&]*\+/.test(url), "a '+' in the text breaks the DLT match");
  assert.match(url, /&dtm=170716/, 'the DLT template id rides along');
  assert.ok(!/URLSearchParams/.test(SMS.slice(SMS.indexOf('function buildUrl'), SMS.indexOf('const escapeRe'))));
});

test('the password never reaches the log', () => {
  const m = sms.maskUrl('https://x/t?appid=A&pass=s3cret&token=abc&to=91');
  assert.ok(!/s3cret/.test(m) && !/abc/.test(m), 'credentials in an audit row are a leak');
  assert.match(m, /pass=••••/);
});

test('91 is the default country code, and is never applied twice', () => {
  assert.equal(sms.normTo('9820012345'), '919820012345');
  assert.equal(sms.normTo('09820012345'), '919820012345', 'a trunk 0 goes');
  assert.equal(sms.normTo('919820012345'), '919820012345', 'already prefixed — leave it');
  assert.equal(sms.normTo('+91 98200-12345'), '919820012345');
  assert.equal(sms.normTo('9820012345', true), '9820012345', 'plain when the setting says so');
  assert.equal(sms.normTo(''), '');
});

test('the OTP text is the registered template, never composed at the call site', () => {
  // DLT matches the delivered text against the template registered for the
  // sender; a sentence written in the route is refused however well it reads.
  assert.match(SMS, /tpl\.replace\(\/\\\{otp\\\}\/gi, String\(code\)\)/);
  const route = read('routes', 'clientAuth.js');
  assert.match(route, /sms\.sendOtp\(target\.mobile, ch\.code/);
  assert.ok(!/is your Ashika OFS sign-in code/.test(route),
    'the hand-written message is what the gateway was refusing');
});

test('the API provider is configuration, not a deploy', () => {
  for (const k of ['OFS_SMS_API_URL', 'OFS_SMS_API_TOKEN', 'OFS_SMS_API_FIELD_TO',
                   'OFS_SMS_API_FIELD_TEXT', 'OFS_SMS_API_FAILURE_CONTAINS']) {
    assert.match(SMS, new RegExp(k), k + ' is not readable from the environment');
  }
  assert.match(read('.env.example'), /OFS_SMS_PROVIDER=gateway/);
  // a 200 carrying a refusal is a refusal on this route too
  assert.match(SMS, /if \(ok && fail\) \{/);
});

test('configured() asks, rather than assuming', async () => {
  // A sign-in decides whether a mobile alone is a way in on this answer.
  const was = process.env.OFS_SMS_PROVIDER;
  try {
    process.env.OFS_SMS_PROVIDER = 'off';
    assert.equal(await sms.configured(), false);
    process.env.OFS_SMS_PROVIDER = 'api';
    const u = process.env.OFS_SMS_API_URL; delete process.env.OFS_SMS_API_URL;
    assert.equal(await sms.configured(), false, 'api with no URL cannot send');
    if (u) process.env.OFS_SMS_API_URL = u;
  } finally {
    if (was === undefined) delete process.env.OFS_SMS_PROVIDER; else process.env.OFS_SMS_PROVIDER = was;
  }
  assert.match(read('routes', 'clientAuth.js'), /const canSms = await sms\.configured\(\);/);
});

test('every attempt is logged where the email is', () => {
  assert.match(SMS, /logSms\(\{/);
  assert.match(read('lib', 'emailLog.js'), /channel: 'sms'/);
  assert.match(read('lib', 'emailLog.js'), /request_detail/, 'the masked gateway call');
  // and there is a way to prove it works before a client finds out it does not
  assert.match(read('package.json'), /"check-sms": "node scripts\/check-sms\.js"/);
});
