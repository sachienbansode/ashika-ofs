'use strict';
/**
 * Create or change the console's operator account.
 *
 *   npm run set-password                  prompts, hidden input
 *   npm run set-password -- qa "secret"   for a scripted install
 *
 * Writes a bcrypt HASH and a fresh signing secret into qa/.env, never the
 * password. The file is the only place either lives, it is gitignored, and it
 * is written 0600 where the platform honours that.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const readline = require('readline');

const ENV = path.join(__dirname, '..', '.env');

function upsert(text, key, value) {
  const line = key + '=' + value;
  const re = new RegExp('^' + key + '=.*$', 'm');
  return re.test(text) ? text.replace(re, line) : (text.replace(/\s*$/, '') + '\n' + line + '\n');
}

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Echo nothing at all rather than asterisks: a length is a hint.
      const out = process.stdout;
      rl._writeToOutput = function (s) { if (!/\n/.test(s)) return; out.write(s); };
      out.write(question);
    }
    rl.question(hidden ? '' : question, (a) => { rl.close(); if (hidden) out.write('\n'); resolve(a); });
  });
}

async function main() {
  let user = process.argv[2];
  let pass = process.argv[3];
  if (!user) user = (await ask('Operator user [qa]: ')).trim() || 'qa';
  if (!pass) {
    pass = await ask('Password: ', true);
    const again = await ask('Again: ', true);
    if (pass !== again) { console.error('They do not match.'); process.exit(1); }
  }
  if (String(pass).length < 10) {
    console.error('Use at least 10 characters. This console can start a process and it stores');
    console.error('workbooks holding every OFS credential the suite is given.');
    process.exit(1);
  }

  let text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  text = upsert(text, 'OFS_QA_USER', user);
  text = upsert(text, 'OFS_QA_PASSWORD_HASH', bcrypt.hashSync(String(pass), 12));
  // Rotating the secret signs out every existing session, which is what
  // changing the password should do.
  text = upsert(text, 'OFS_QA_SECRET', crypto.randomBytes(32).toString('base64url'));
  if (!/^OFS_QA_PORT=/m.test(text)) text = upsert(text, 'OFS_QA_PORT', '4100');
  if (!/^OFS_QA_KEEP_DAYS=/m.test(text)) text = upsert(text, 'OFS_QA_KEEP_DAYS', '7');
  if (!/^OFS_QA_COOKIE_SECURE=/m.test(text)) text = upsert(text, 'OFS_QA_COOKIE_SECURE', 'false');

  fs.writeFileSync(ENV, text, { mode: 0o600 });
  try { fs.chmodSync(ENV, 0o600); } catch (e) { /* Windows */ }
  console.log('Wrote ' + ENV);
  console.log('User "' + user + '". Every existing session is now signed out.');
  console.log('Behind TLS? set OFS_QA_COOKIE_SECURE=true in that file.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
