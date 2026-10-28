'use strict';
/**
 * Prove SMS works, before a client finds out it does not.
 *
 *   npm run check-sms                 -- report the configuration only
 *   npm run check-sms 9820012345      -- and send one real message to that number
 *
 * Reports which route is in force, what the platform has configured, and — when
 * given a number — the gateway's own reply, which is the only thing that
 * actually says whether a message was accepted.
 */
require('dotenv').config({ override: true });
const sms = require('../lib/sms');

const ok = (m, d) => console.log('  ok    ' + m + (d ? '  — ' + d : ''));
const warn = (m, d) => console.log('  warn  ' + m + (d ? '  — ' + d : ''));
const bad = (m, d) => console.log('  FAIL  ' + m + (d ? '  — ' + d : ''));

async function main() {
  const p = sms.provider();
  console.log('\nSMS route      : ' + p +
    (p === 'gateway' ? '  (the platform\'s own gateway settings)' :
     p === 'api' ? '  (OFS_SMS_API_URL)' : '  (switched off)'));

  if (p === 'off') { warn('sending is off', 'set OFS_SMS_PROVIDER=gateway or api'); return 0; }

  if (p === 'api') {
    const url = String(process.env.OFS_SMS_API_URL || '').trim();
    (url ? ok : bad)('OFS_SMS_API_URL', url || 'not set — nothing can be sent');
    (process.env.OFS_SMS_API_TOKEN ? ok : warn)('OFS_SMS_API_TOKEN',
      process.env.OFS_SMS_API_TOKEN ? 'set' : 'not set — fine only if the endpoint is open');
  } else {
    const cfg = await sms.config();
    if (!Object.keys(cfg).length) {
      bad('platform SMS settings', 'app_settings row not readable — check the Ananta connection');
      return 1;
    }
    (cfg.sms_enabled ? ok : bad)('gateway enabled in Settings',
      cfg.sms_enabled ? '' : 'Admin · Settings → SMS Gateway → Enable');
    (cfg.sms_appid && cfg.sms_user_id ? ok : bad)('primary gateway credentials',
      cfg.sms_appid ? 'appid ' + cfg.sms_appid : 'appid/userId missing');
    (cfg.sms_fb_appid && cfg.sms_fb_user_id ? ok : warn)('fallback gateway',
      cfg.sms_fb_appid ? 'configured' : 'none — a primary outage stops SMS');
    (cfg.sms_header ? ok : bad)('sender header', cfg.sms_header || 'missing');
    (cfg.sms_otp_template_id ? ok : bad)('DLT template id', cfg.sms_otp_template_id || 'missing — the gateway will answer -3');
    (cfg.sms_otp_text ? ok : warn)('DLT template text', cfg.sms_otp_text || 'falling back to the built-in wording');
    if (cfg.sms_otp_text && !/\{otp\}/i.test(cfg.sms_otp_text)) {
      bad('template text has no {otp}', 'the code would never appear in the message');
    }
  }

  const to = process.argv[2];
  if (!to) {
    console.log('\nPass a mobile number to send one real test message:  npm run check-sms 9820012345\n');
    return 0;
  }
  console.log('\nsending to ' + sms.normTo(to) + ' …');
  const r = await sms.sendOtp(to, '000000', { purpose: 'ofs_sms_check', triggeredBy: 'check-sms' });
  if (r.sent) { ok('accepted by ' + (r.gateway || 'provider'), (r.ms || '?') + 'ms · reply: ' + (r.response || '')); return 0; }
  bad('not sent', r.error || r.reason || 'unknown');
  console.log('\n  The reply above is the gateway\'s own. -1 is credentials, -2 parameters,');
  console.log('  -3 sender ID / DLT template / IP not whitelisted.\n');
  return 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e.message); process.exit(1); });
