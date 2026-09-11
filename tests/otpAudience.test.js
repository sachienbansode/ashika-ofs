'use strict';
/**
 * Which one-time codes are real, and which are fixed for UAT.
 *
 * The split matters: client-facing codes stay fixed until go-live because UAT has no
 * real client mailboxes to send to, but the back-office door leads to every client's
 * PII and to the exchange files. A fixed code there is a shared password, not a test
 * convenience — so it defaults the other way.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const otp = require('../lib/otp');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; 
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('client codes are fixed only when explicitly switched on', () => {
  withEnv({ OFS_OTP_TEST_MODE: undefined, NODE_ENV: 'uat' }, () => assert.equal(otp.testMode(), false));
  withEnv({ OFS_OTP_TEST_MODE: 'true', NODE_ENV: 'uat' }, () => assert.equal(otp.testMode(), true));
});

test('back-office codes are REAL even while client codes are fixed', () => {
  withEnv({ OFS_OTP_TEST_MODE: 'true', OFS_STAFF_OTP_TEST_MODE: undefined, NODE_ENV: 'uat' }, () => {
    assert.equal(otp.testMode(), true, 'client side should be in test mode');
    assert.equal(otp.staffTestMode(), false, 'the desk must not inherit the client test code');
  });
});

test('the desk can be put in test mode, but only deliberately', () => {
  withEnv({ OFS_STAFF_OTP_TEST_MODE: 'true', NODE_ENV: 'uat' },
    () => assert.equal(otp.staffTestMode(), true));
});

test('production refuses a fixed code on either side, whatever the flag says', () => {
  withEnv({ OFS_OTP_TEST_MODE: 'true', OFS_STAFF_OTP_TEST_MODE: 'true', NODE_ENV: 'production' }, () => {
    assert.equal(otp.testMode(), false);
    assert.equal(otp.staffTestMode(), false);
  });
});

test('staff sign-in uses the staff switch, not the client one', () => {
  const src = read('routes/staffAuth.js');
  assert.match(src, /otp\.staffTestMode\(\)/);
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.ok(!/otp\.testMode\(\)/.test(code), 'staff sign-in must not read the client test flag');
});

test('the client, branch and bid-confirmation paths all use the client switch', () => {
  for (const f of ['lib/clientAuth.js', 'routes/branchAuth.js', 'lib/bidOtp.js']) {
    assert.match(read(f), /testMode\(\)/, f + ' does not honour the client test flag');
    assert.ok(!/staffTestMode/.test(read(f)), f + ' should not use the staff flag');
  }
});

test('a code is generated with crypto, never Math.random', () => {
  // Comments are allowed to mention it — the comment there explains WHY not.
  const src = read('lib/otp.js');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.match(code, /crypto\.randomInt/);
  assert.ok(!/Math\.random/.test(code), 'a guessable code is no protection at all');
});

test('the SQL that turns MFA on warns about locking the desk out', () => {
  const sql = read('docs/sql/ofs_staff_mfa.sql');
  assert.match(sql, /requires_mfa = true/);
  assert.match(sql, /OFS-Backoffice/);
  assert.match(sql, /locks the desk out/);
  assert.match(sql, /OFS_STAFF_OTP_TEST_MODE=true/);
});
