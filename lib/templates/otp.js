'use strict';
/**
 * lib/templates/otp.js — the one sign-in-code email.
 *
 * There were three copies of this, in routes/staffAuth.js, routes/clientAuth.js and
 * routes/branchAuth.js: the same code block, the same expiry line, three slightly
 * different greetings and three slightly different security notes. A template that
 * exists three times is a template that drifts, and the one thing every one of these
 * mails has to do identically is teach the reader what a genuine Ashika code looks
 * like — that is the whole defence against someone being talked into reading a code
 * down a phone line.
 *
 * Shaped after omnenest-uploader-api routes/auth.js: a heading, the greeting, the
 * code as the one large element on the page, and the expiry as an actual IST clock
 * time rather than a duration the reader has to add to whenever they opened the mail.
 */
const { brandedEmail } = require('../emailBranding');

/** Belt and braces: these strings reach an HTML document. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * "09:42 PM IST (about 10 minutes from now)".
 *
 * A mail read eleven minutes after it was sent says "expires in 10 minutes" and is
 * wrong; a clock time is still true whenever it is read. Both are given because the
 * duration is what someone skims and the time is what they can act on.
 */
function expiryLine(mins, expiresAt) {
  const m = Math.max(1, Math.round(Number(mins) || 0));
  const plural = m === 1 ? '' : 's';
  if (!expiresAt) return 'This code expires in <strong>' + m + ' minute' + plural + '</strong> and can be used once.';
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (isNaN(d)) return 'This code expires in <strong>' + m + ' minute' + plural + '</strong> and can be used once.';
  // en-IN gives a lowercase "pm"; every other time in this product is AM/PM.
  const time = d.toLocaleString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
  }).replace(/\b(am|pm)\b/i, (x) => x.toUpperCase());
  return 'This code is valid until <strong>' + esc(time) + ' IST</strong> (about ' + m +
         ' minute' + plural + ' from now) and can be used once.';
}

/**
 * @param {object} o
 *   name       who to greet; falsy becomes a neutral greeting rather than "Hello null"
 *   code       the one-time code
 *   minutes    how long it lasts
 *   expiresAt  Date|string, optional — turns the duration into a clock time
 *   audience   'staff' | 'branch' | 'client'; decides the heading, what is being
 *              signed in to, and the closing warning, which genuinely differ:
 *              a client can ignore a code they did not ask for, but a member of
 *              staff receiving one means their portal password is already in
 *              someone else's hands.
 */
function otpEmail(o) {
  o = o || {};
  const audience = o.audience || 'client';
  const who = audience === 'client' ? 'Investor' : 'there';
  const where = audience === 'staff'
    ? 'the Ashika OFS BackOffice'
    : 'the Ashika OFS bidding module';
  const warn = audience === 'staff'
    ? 'If this was not you, your portal password may be known to someone else — change it now and tell IT.'
    : 'If you did not request it, ignore this email — no one can sign in without this code. '
      + 'Ashika will never ask you for it by phone, SMS or email.';

  return brandedEmail(
    '<h2 style="margin:0 0 12px;font-size:17px;color:#243f8e">Sign-in verification</h2>' +
    '<p style="margin:0 0 14px">' + (audience === 'client' ? 'Dear ' : 'Hello ') +
      esc(o.name || who) + ',</p>' +
    '<p style="margin:0 0 18px">Use this code to sign in to ' + where + ':</p>' +
    '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:700;' +
      'letter-spacing:.22em;color:#243f8e;background:#f2f7fb;border:1px solid #e2ecf2;' +
      'border-radius:10px;padding:16px;text-align:center;margin:0 0 18px">' + esc(o.code) + '</div>' +
    '<p style="margin:0 0 6px;color:#6b7f9e;font-size:12px">' + expiryLine(o.minutes, o.expiresAt) + '</p>' +
    '<p style="margin:0;color:#6b7f9e;font-size:12px">' + warn + '</p>'
  );
}

/**
 * The mail check's own email. It was the one send in the app that skipped the shell
 * entirely and went out as a bare <p> — which is exactly the wrong email to send
 * unbranded, because its whole job is to show what a real one will look like.
 */
function mailCheckEmail(opts) {
  opts = opts || {};
  return brandedEmail(
    '<h2 style="margin:0 0 12px;font-size:17px;color:#243f8e">Mail check</h2>' +
    '<p style="margin:0 0 14px">If you are reading this, OFS can send email: sign-in codes, ' +
    'bid confirmations and allotment advices will all arrive.</p>' +
    '<p style="margin:0 0 6px;color:#6b7f9e;font-size:12px">Sent by <code>npm run check-mail</code> on ' +
    esc(opts.host || 'the OFS server') + ' at ' +
    esc(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })
      .replace(/\b(am|pm)\b/i, (x) => x.toUpperCase())) + ' IST' +
    (opts.source ? ', using ' + (opts.source === 'env' ? "this app's own SMTP settings"
      : "the platform's SMTP settings") : '') + '.</p>' +
    '<p style="margin:0;color:#6b7f9e;font-size:12px">Nobody needs to act on this message.</p>'
  );
}

module.exports = { otpEmail, mailCheckEmail, expiryLine };
