#!/usr/bin/env node
'use strict';
/**
 * Why did the sign-in code not send?
 *
 * Every path to that answer inside the app needs a session, and the failure being
 * diagnosed is the one that stops you getting a session. So this runs on the server,
 * from the shell, and says which of the four things is actually wrong:
 *
 *   1. no SMTP row at all in "admin-staging-api".smtp_settings
 *   2. a row with no host
 *   3. a password that will not decrypt — API_KEY_SECRET here differs from the one
 *      the portal sealed it with, which is the most common cause and the one that
 *      looks identical to every other cause from the login screen
 *   4. the SMTP server itself refusing the connection or the credentials
 *
 *   npm run check-mail                  -> settings, decryption, and a live connection test
 *   npm run check-mail -- you@ashika... -> the above, then actually send there
 */
require('dotenv').config();

const mailer = require('../lib/mailer');
const { mailCheckEmail } = require('../lib/templates/otp');
const { adminOne } = require('../db/adminAdapter');

const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = (m) => console.log('  \x1b[31m✗\x1b[0m ' + m);
const info = (m) => console.log('    ' + m);

(async () => {
  console.log('\nOFS mail check\n');

  let s;
  try {
    s = await mailer.getSmtpSettings();
  } catch (e) {
    bad('Could not read smtp_settings: ' + e.message);
    info('This is a database problem, not a mail one. Check ANANTA_* in .env.');
    process.exit(2);
  }

  if (!s) {
    bad('There is no row in "admin-staging-api".smtp_settings (id = 1).');
    info('The portal writes this row. Configure SMTP in the Stage API admin screens,');
    info('or set SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM in this app\'s .env.');
    process.exit(2);
  }
  ok(s.source === 'env'
    ? 'using SMTP_* from this app\'s .env (the platform row is not consulted)'
    : 'smtp_settings row found (from the platform)');
  info('host      ' + (s.host || '(none)') + ':' + (s.port || 587) + (s.secure ? ' (TLS)' : ''));
  info('username  ' + (s.username || '(none)'));
  info('from      ' + (s.from_email || s.username || '(none)'));

  if (!s.host) {
    bad('The row has no host, so nothing can be sent.');
    process.exit(2);
  }

  if (s.username) {
    const pass = mailer.passwordOf(s);
    if (!pass && s.source === 'env') {
      bad('SMTP_USER is set but SMTP_PASS is empty.');
      info('For a Google Workspace account this must be an APP PASSWORD, not the');
      info('account password — a normal password fails with 535 even when correct.');
      process.exit(2);
    }
    if (!pass) {
      bad('The stored password will not decrypt.');
      info('API_KEY_SECRET in this app\'s .env must be BYTE-IDENTICAL to the portal\'s —');
      info('that is what the password was sealed with. A trailing space or a quote is enough');
      info('to break it, and the login screen cannot tell you that.');
      info('');
      // The portal is usually NOT this host — OFS has its own VM and its own PM2
      // process, and reaches the platform over the database. Saying "on the portal"
      // without saying "which may be another machine" sent one person hunting for
      // a second .env on this box that was never going to be here.
      info('The portal (omnenest-uploader-api) is a SEPARATE host — the one that');
      info('writes smtp_settings, not this VM. Get its value there:');
      info('');
      info('    grep API_KEY_SECRET .env        # on the portal host');
      info('');
      info('then set the same value here. API_KEY_SECRET is used for this one');
      info('purpose in OFS, so changing it breaks nothing else.');
      info('');
      info('Or skip the portal entirely and hold the credentials here:');
      info('');
      info('    SMTP_HOST=smtp.gmail.com');
      info('    SMTP_PORT=587');
      info('    SMTP_USER=it.notifications@ashikagroup.com');
      info('    SMTP_PASS=<the Google app password>');
      info('    SMTP_FROM=it.notifications@ashikagroup.com');
      info('');
      info('When SMTP_HOST is set the platform row is not read at all, and');
      info('API_KEY_SECRET stops mattering. Sends are still logged to the shared');
      info('Email & OTP Logs either way.');
      process.exit(2);
    }
    ok(s.source === 'env'
      ? 'password present (' + pass.length + ' characters)'
      : 'password decrypts (' + pass.length + ' characters)');
  } else {
    info('no username set — treating this as an unauthenticated relay');
  }

  const st = await mailer.status();
  if (!st.ok) { bad('mailer.status(): ' + st.reason + (st.hint ? ' — ' + st.hint : '')); process.exit(2); }
  ok('mailer reports ready');

  // A live connection. This is the step that catches a firewall, a wrong port, or
  // credentials the server refuses — none of which the rows above can show.
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({
    host: s.host, port: Number(s.port) || 587, secure: !!s.secure,
    // passwordOf, NOT decryptPass: on the SMTP_* path there is no sealed field, so
    // decryptPass returns '' and the server refuses a correct password with a 535
    // that blames the credentials.
    auth: s.username ? { user: s.username, pass: mailer.passwordOf(s) } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000
  });
  try {
    await t.verify();
    ok('SMTP server accepted the connection and the credentials');
  } catch (e) {
    bad('SMTP refused: ' + e.message);
    if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/.test(String(e.code || e.message))) {
      info('That is a network answer, not an authentication one — this server cannot reach');
      info(s.host + ':' + (s.port || 587) + '. Check the outbound rule for that port.');
    }
    if (/535|Invalid login|auth/i.test(e.message)) {
      info('The credentials were rejected.');
      if (s.source === 'env') {
        info('SMTP_PASS must be a Google APP PASSWORD (16 characters, no spaces), not the');
        info('mailbox password. Check for a stray quote or trailing space in .env too.');
      } else {
        info('If the mailbox uses app passwords, the stored one may have been revoked —');
        info('it has to be re-entered in the portal, not here.');
      }
    }
    process.exit(2);
  }

  const to = process.argv[2];
  if (!to) {
    console.log('\nMail is working. To prove it end to end:\n  npm run check-mail -- you@ashikagroup.com\n');
    process.exit(0);
  }

  const r = await mailer.send({
    to, subject: 'Ashika OFS — mail check',
    html: mailCheckEmail({ host: require('os').hostname(), source: s.source }),
    purpose: 'ofs_mail_check', triggeredBy: 'check-mail'
  });
  if (r.sent) { ok('sent to ' + to + ' (' + (r.messageId || 'no id') + ')'); console.log(''); process.exit(0); }
  bad('send failed: ' + (r.error || 'unknown'));
  process.exit(2);
})().catch((e) => { bad(e.stack || e.message); process.exit(2); });
