'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const ROUTE = read('routes', 'clientAuth.js');
const CLIENT = read('public', 'client', 'client.js');
const LOGIN = read('public', 'backoffice', 'login.js');

/* ---------------------------------------------------------------------------
 * Going live on real codes, with 3,157 of 36,720 active accounts carrying no
 * email address.
 *
 * Every one of those was told "We could not send the code just now. Please try
 * again shortly." — false, identical to what a real SMTP outage says, and an
 * invitation to try for ever. A missing contact is not a transient fault.
 * ------------------------------------------------------------------------- */

test('an account with nothing to send to is told so, not asked to retry', () => {
  assert.match(ROUTE, /error: why, kind, identifier/);
  assert.match(ROUTE, /const why = !target\.email && !target\.mobile \? 'no_contact_on_file' : 'no_email_on_file';/);
  assert.match(ROUTE, /422/, 'a missing contact is not a 503 — there is nothing to retry');
  assert.match(ROUTE, /contact your relationship manager or the OFS desk/);
});

test('a mobile alone is only a way in once SMS can actually deliver', () => {
  // No provider is wired yet, so email is the only channel that delivers. The
  // check asks sms.configured() rather than assuming, so wiring one changes this
  // without anybody remembering to come back here.
  assert.match(ROUTE, /const canSms = sms\.configured\(\);/);
  assert.match(ROUTE, /if \(!target\.email && !\(target\.mobile && canSms\)\)/);
  assert.match(ROUTE, /We can only send sign-in codes by email at present/);
});

test('the screen names the channel that carried it, not the one addressed', () => {
  // sent_to was built BEFORE either send was attempted, so a client whose SMS
  // went nowhere was told it had been sent to their mobile, and waited.
  assert.match(ROUTE, /out\.sent_to = \[results\[0\]\.sent \? ca\.maskEmail/);
  assert.match(ROUTE, /out\.channels = \{ email: !!results\[0\]\.sent, sms: !!results\[1\]\.sent \}/);
  assert.match(CLIENT, /var ch = r\.channels \|\| \{\};/);
  assert.match(CLIENT, /use whichever reaches you first/);
});

test('a client is still tried on both channels, as the data allows', () => {
  // One succeeding is enough; neither is a 503. That part was already right.
  assert.match(ROUTE, /const delivered = results\.some\(\(r\) => r\.sent\);/);
  assert.match(ROUTE, /target\.email\s*\n\s*\? mailer\.send/);
  assert.match(ROUTE, /target\.mobile\s*\n\s*\? sms\.send/);
});

test('a branch, an AP and the desk are told their code goes by email only', () => {
  assert.match(CLIENT, /codes for a branch or AP go by email only/);
  assert.match(LOGIN, /\(email only\)/);
});
