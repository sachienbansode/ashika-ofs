'use strict';
/**
 * SMTP transport, reusing the platform's configuration exactly (REUSE.md 3):
 * settings come from "admin-staging-api".smtp_settings (id=1) in the Ananta
 * database, and the password is AES-256-GCM sealed with API_KEY_SECRET — the same
 * scheme workers/etlMailer.js uses. OFS stores no SMTP credentials of its own.
 *
 * Every send is logged through lib/emailLog.js, so OFS mail appears in
 * Admin -> Email & OTP Logs alongside every other platform email.
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { adminOne, SCHEMA } = require('../db/adminAdapter');
const { logEmail, logFromInfo } = require('./emailLog');

function decryptPass(enc) {
  if (!enc) return '';
  try {
    const secret = process.env.API_KEY_SECRET || 'ashika-default-secret';
    const key = crypto.createHash('sha256').update(secret).digest();
    const [ivHex, tagHex, encHex] = String(enc).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    d.setAuthTag(Buffer.from(tagHex, 'hex'));
    return d.update(Buffer.from(encHex, 'hex')) + d.final('utf8');
  } catch (_) { return ''; }
}

/**
 * SMTP config from this app's own environment, when it is set.
 *
 * The platform row stays the default and the single source of truth. This exists
 * because reading it needs API_KEY_SECRET to be byte-identical to the portal's, the
 * portal is a DIFFERENT HOST, and back-office MFA is on the other side of that
 * dependency — so a secret nobody on this box can produce locks everyone out of
 * OFS. Setting SMTP_HOST here is the escape hatch: same credentials, held locally,
 * no portal round trip.
 *
 * Shaped exactly like the database row so nothing downstream can tell them apart.
 */
function envSmtp() {
  const h = String(process.env.SMTP_HOST || '').trim();
  if (!h) return null;
  const user = String(process.env.SMTP_USER || '').trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  return {
    host: h,
    port,
    // 465 is implicit TLS; 587 is STARTTLS, which nodemailer does with secure:false.
    secure: process.env.SMTP_SECURE != null
      ? /^(1|true|yes)$/i.test(String(process.env.SMTP_SECURE).trim())
      : port === 465,
    username: user,
    // Held in plain text here on purpose: sealing it would need the very secret
    // this path exists to do without. Keep .env 0600 and owned by the app user.
    password_plain: String(process.env.SMTP_PASS || ''),
    from_email: String(process.env.SMTP_FROM || user).trim(),
    from_name: String(process.env.SMTP_FROM_NAME || '').trim() || null,
    source: 'env'
  };
}

async function getSmtpSettings() {
  const local = envSmtp();
  if (local) return local;
  const row = await adminOne(`SELECT * FROM "${SCHEMA}".smtp_settings WHERE id = 1`);
  return row ? Object.assign({ source: 'platform' }, row) : row;
}

/** The password, whichever way the settings arrived. */
function passwordOf(s) {
  if (!s) return '';
  return s.password_plain != null ? s.password_plain : decryptPass(s.password_encrypted);
}

/** Is mail usable right now? Cheap enough for a UI badge. */
async function status() {
  try {
    const s = await getSmtpSettings();
    if (!s || !s.host) return { ok: false, reason: 'smtp_not_configured' };
    if (s.username && !passwordOf(s)) {
      return s.source === 'env'
        ? { ok: false, reason: 'password_missing', source: 'env', hint: 'SMTP_USER is set but SMTP_PASS is empty' }
        : { ok: false, reason: 'password_undecryptable', source: 'platform',
            hint: 'API_KEY_SECRET must match the platform, or set SMTP_HOST here instead' };
    }
    return { ok: true, source: s.source, host: s.host, port: s.port || 587,
             from: s.from_email || s.username };
  } catch (e) { return { ok: false, reason: 'settings_unreadable', error: e.message }; }
}

let cached = null;
async function transport() {
  const s = await getSmtpSettings();
  if (!s || !s.host) { const e = new Error('smtp_not_configured'); e.code = 'SMTP_OFF'; throw e; }
  const key = [s.source, s.host, s.port, s.secure, s.username].join('|');
  if (cached && cached.key === key) return { t: cached.t, s };
  const t = nodemailer.createTransport({
    host: s.host,
    port: s.port || 587,
    secure: !!s.secure,
    auth: s.username ? { user: s.username, pass: passwordOf(s) } : undefined
  });
  cached = { key, t };
  return { t, s };
}

function fromLine(s) {
  return s.from_name ? `${s.from_name} <${s.from_email || s.username}>` : (s.from_email || s.username);
}

/**
 * Send one email and log it either way.
 * @returns {{sent:boolean, messageId?:string, error?:string}}
 */
async function send({ to, subject, html, purpose, triggeredBy, ip }) {
  const base = { purpose: purpose || 'ofs', to_email: to, subject,
                 triggered_by: triggeredBy || 'system', ip_address: ip || null };
  if (!to || !String(to).trim()) {
    await logEmail(Object.assign({}, base, { status: 'failed', error_text: 'no recipient' }));
    return { sent: false, error: 'no_recipient' };
  }
  let t, s;
  try { ({ t, s } = await transport()); }
  catch (e) {
    await logEmail(Object.assign({}, base, { status: 'failed', error_text: e.message }));
    return { sent: false, error: e.message };
  }
  try {
    const info = await t.sendMail({ from: fromLine(s), to, subject, html });
    await logFromInfo(base, info);
    return { sent: true, messageId: info.messageId };
  } catch (e) {
    await logEmail(Object.assign({}, base, { status: 'failed', error_text: e.message }));
    return { sent: false, error: e.message };
  }
}

module.exports = { send, status, getSmtpSettings, decryptPass, envSmtp, passwordOf };
