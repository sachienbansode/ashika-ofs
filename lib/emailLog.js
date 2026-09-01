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
  _ready = true;
}

async function logEmail(d) {
  try {
    await ensureEmailLogs();
    await adminQuery(
      `INSERT INTO "${SCHEMA}".email_logs
         (purpose, to_email, user_id, subject, status, accepted, rejected,
          message_id, smtp_response, error_text, ip_address, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [d.purpose || null, d.to_email || null, d.user_id || null, d.subject || null,
       d.status || null, d.accepted || null, d.rejected || null, d.message_id || null,
       d.smtp_response || null, d.error_text || null, d.ip_address || null, d.triggered_by || null]);
  } catch (e) {
    console.error('[emaillog]', e.message);   // logging must never break a send
  }
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

module.exports = { logEmail, logFromInfo, ensureEmailLogs };
