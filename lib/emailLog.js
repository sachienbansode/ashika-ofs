'use strict';
/**
 * Ported from omnenest-uploader-api lib/emailLog.js (REUSE.md 3) so OFS sends land
 * in the SAME Admin -> Email & OTP Logs grid as every other platform email.
 * The table lives in the admin schema in the Ananta database, not in ofs_bids.
 *
 * `purpose` doubles as the type. OFS adds: ofs_allotment | ofs_bid_otp.
 */
const { adminQuery, SCHEMA } = require('../db/adminAdapter');

let _ready = false;

/**
 * The platform creates and back-fills this table. OFS only ensures it exists so a
 * fresh environment does not lose the first send; it never alters the columns the
 * platform owns.
 */
async function ensureEmailLogs() {
  if (_ready) return;
  await adminQuery(`CREATE TABLE IF NOT EXISTS "${SCHEMA}".email_logs (
    id            BIGSERIAL PRIMARY KEY,
    purpose       VARCHAR(40),
    to_email      VARCHAR(255),
    user_id       INTEGER,
    subject       TEXT,
    status        VARCHAR(12),
    accepted      TEXT,
    rejected      TEXT,
    message_id    TEXT,
    smtp_response TEXT,
    error_text    TEXT,
    ip_address    VARCHAR(64),
    triggered_by  VARCHAR(255),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`).catch(() => {});
  /* The platform added these two for SMS; an OFS talking to an older database
     must not fall over because of it, and must not try to own the column either.
     ADD COLUMN IF NOT EXISTS is a no-op where the platform already has them. */
  for (const col of ["channel VARCHAR(8) DEFAULT 'email'", 'request_detail TEXT']) {
    await adminQuery(`ALTER TABLE "${SCHEMA}".email_logs ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
  _ready = true;
}

async function logEmail(d) {
  try {
    await ensureEmailLogs();
    await adminQuery(
      `INSERT INTO "${SCHEMA}".email_logs
         (purpose, to_email, user_id, subject, status, accepted, rejected,
          message_id, smtp_response, error_text, ip_address, triggered_by,
          channel, request_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [d.purpose || null, d.to_email || null, d.user_id || null, d.subject || null,
       d.status || null, d.accepted || null, d.rejected || null, d.message_id || null,
       d.smtp_response || null, d.error_text || null, d.ip_address || null, d.triggered_by || null,
       d.channel || 'email', d.request_detail || null]);
  } catch (e) {
    console.error('[emaillog]', e.message);   // logging must never break a send
  }
}

/**
 * One SMS, in the same grid as the email.
 *
 * Ported from the platform's own logSms so a code sent by text and a code sent by
 * mail are read off one screen rather than two. `subject` carries the message
 * body and `request_detail` the gateway call with the password masked out — an
 * SMS that did not arrive is almost always answered by the gateway's own reply,
 * and that reply is worth nothing if nobody can find it.
 */
async function logSms(d) {
  await logEmail({
    channel: 'sms',
    purpose: d.purpose || 'sms',
    to_email: d.to || null,
    user_id: d.user_id || null,
    subject: d.text || null,
    status: d.status || null,
    message_id: d.message_id || null,
    smtp_response: d.response || null,
    request_detail: d.request || null,
    error_text: d.error_text || null,
    ip_address: d.ip_address || null,
    triggered_by: d.triggered_by || 'system'
  });
}

/** Log straight from a nodemailer sendMail() result. */
async function logFromInfo(base, info) {
  await logEmail(Object.assign({}, base, {
    status: 'sent',
    accepted: ((info && info.accepted) || []).join(', '),
    rejected: ((info && info.rejected) || []).join(', '),
    message_id: (info && info.messageId) || null,
    smtp_response: (info && info.response) || null
  }));
}

module.exports = { logEmail, logFromInfo, logSms, ensureEmailLogs };
