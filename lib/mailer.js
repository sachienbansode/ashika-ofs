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

async function getSmtpSettings() {
  return adminOne(`SELECT * FROM "${SCHEMA}".smtp_settings WHERE id = 1`);
}

/** Is mail usable right now? Cheap enough for a UI badge. */
async function status() {
  try {
    const s = await getSmtpSettings();
    if (!s || !s.host) return { ok: false, reason: 'smtp_not_configured' };
    if (s.username && !decryptPass(s.password_encrypted)) {
      return { ok: false, reason: 'password_undecryptable', hint: 'API_KEY_SECRET must match the platform' };
    }
    return { ok: true, host: s.host, port: s.port || 587, from: s.from_email || s.username };
  } catch (e) { return { ok: false, reason: 'settings_unreadable', error: e.message }; }
}

let cached = null;
async function transport() {
  const s = await getSmtpSettings();
  if (!s || !s.host) { const e = new Error('smtp_not_configured'); e.code = 'SMTP_OFF'; throw e; }
  const key = [s.host, s.port, s.secure, s.username].join('|');
  if (cached && cached.key === key) return { t: cached.t, s };
  const t = nodemailer.createTransport({
    host: s.host,
    port: s.port || 587,
    secure: !!s.secure,
    auth: s.username ? { user: s.username, pass: decryptPass(s.password_encrypted) } : undefined
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

module.exports = { send, status, getSmtpSettings, decryptPass };
