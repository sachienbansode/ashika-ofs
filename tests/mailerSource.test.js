'use strict';
/**
 * Where the SMTP credentials come from.
 *
 * The platform row is the default and the single source of truth, and reading it
 * needs API_KEY_SECRET to be byte-identical to the portal's. The portal is a
 * different host, and back-office MFA sits on the far side of that dependency — a
 * secret nobody on the OFS box can produce locks every member of staff out of OFS.
 * So SMTP_HOST in this app's own .env overrides it, and the two paths have to be
 * indistinguishable to everything downstream.
 */
const test = require('node:test');
const assert = require('node:assert');

const mailer = require('../lib/mailer');

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS',
  'SMTP_FROM', 'SMTP_FROM_NAME'];

function withEnv(vars, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('no SMTP_HOST means the platform row is still the source', () => {
  withEnv({}, () => assert.equal(mailer.envSmtp(), null));
  // Every other SMTP_* on its own is not enough: a half-filled block must not
  // silently take over from a working platform config.
  withEnv({ SMTP_USER: 'a@b.com', SMTP_PASS: 'x' }, () => assert.equal(mailer.envSmtp(), null));
});

test('SMTP_HOST takes over, shaped exactly like the database row', () => {
  withEnv({
    SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587',
    SMTP_USER: 'it.notifications@ashikagroup.com', SMTP_PASS: 'app-password',
    SMTP_FROM: 'it.notifications@ashikagroup.com', SMTP_FROM_NAME: 'Ashika OFS'
  }, () => {
    const s = mailer.envSmtp();
    assert.equal(s.source, 'env');
    assert.equal(s.host, 'smtp.gmail.com');
    assert.equal(s.port, 587);
    assert.equal(s.username, 'it.notifications@ashikagroup.com');
    assert.equal(s.from_name, 'Ashika OFS');
    // The password comes back the same way for both sources, so transport() and
    // status() never have to know which one they are holding.
    assert.equal(mailer.passwordOf(s), 'app-password');
  });
});

test('the port decides TLS unless it is told otherwise', () => {
  // 587 is STARTTLS, which nodemailer does with secure:false; 465 is implicit TLS.
  // Getting this backwards is a connection that hangs rather than an error.
  withEnv({ SMTP_HOST: 'h', SMTP_PORT: '587' }, () => assert.equal(mailer.envSmtp().secure, false));
  withEnv({ SMTP_HOST: 'h', SMTP_PORT: '465' }, () => assert.equal(mailer.envSmtp().secure, true));
  withEnv({ SMTP_HOST: 'h' }, () => {
    assert.equal(mailer.envSmtp().port, 587, 'default port');
    assert.equal(mailer.envSmtp().secure, false);
  });
  withEnv({ SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_SECURE: 'true' },
    () => assert.equal(mailer.envSmtp().secure, true, 'an explicit override wins'));
  withEnv({ SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_SECURE: 'false' },
    () => assert.equal(mailer.envSmtp().secure, false));
});

test('from falls back to the username, and blanks do not become a host', () => {
  withEnv({ SMTP_HOST: 'h', SMTP_USER: 'u@x.com' }, () => {
    const s = mailer.envSmtp();
    assert.equal(s.from_email, 'u@x.com');
    assert.equal(s.from_name, null, 'an empty display name is absent, not an empty string');
  });
  // A commented-out or blank SMTP_HOST is not a configuration.
  withEnv({ SMTP_HOST: '   ' }, () => assert.equal(mailer.envSmtp(), null));
});

test('passwordOf reads a sealed platform password, not a plain one', () => {
  // The platform row has no password_plain, so the sealed field is what is used —
  // and an undecryptable one comes back empty rather than as garbage that would be
  // handed to the SMTP server as a password.
  const row = { username: 'u', password_encrypted: 'not:valid:ciphertext', source: 'platform' };
  assert.equal(mailer.passwordOf(row), '');
  assert.equal(mailer.passwordOf(null), '');
});

test('the env path does not need API_KEY_SECRET at all', () => {
  const saved = process.env.API_KEY_SECRET;
  delete process.env.API_KEY_SECRET;
  try {
    withEnv({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'u@x.com', SMTP_PASS: 'pw' }, () => {
      assert.equal(mailer.passwordOf(mailer.envSmtp()), 'pw',
        'this is the whole point: mail works with no shared secret');
    });
  } finally {
    if (saved === undefined) delete process.env.API_KEY_SECRET; else process.env.API_KEY_SECRET = saved;
  }
});
