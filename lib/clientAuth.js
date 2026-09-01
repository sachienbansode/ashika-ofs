'use strict';
/**
 * Client sign-in: mobile + email, then a one-time code.
 *
 * The pair must match ONE LD record. That is the whole identity claim — so the
 * code is what actually proves it, and everything here is built around not
 * leaking whether a given mobile/email exists.
 *
 * Invariants (carried from the platform):
 *   - the OTP is stored as a sha256 hash and never returned, logged or displayed;
 *   - attempts are counted server-side and capped;
 *   - a wrong pair and a right pair take the same path and return the same shape.
 */
const crypto = require('crypto');
const { SCHEMA, rows, one, query } = require('../db/ofsAdapter');
const ananta = require('../db/anantaAdapter');

const otp = require('./otp');

// Re-exported so callers have one place to look; the primitives live in lib/otp.js
// precisely so they can be tested without a database driver.
const { OTP_TTL_MIN, OTP_MAX_ATTEMPTS, RESEND_COOLDOWN_S, testMode, testOtp,
        normMobile, normEmail, hash, hashMatches, generateOtp, maskEmail, maskMobile,
        identifierKind, normUcc } = otp;

/**
 * Find the client(s) matching ONE identifier - a client code (UCC/ctermcode), a
 * registered mobile, or a registered email. Either side of the join may hold it:
 * dwh.tbl_user_info and stg.ask_clientmast do not always agree, and the client
 * master is the fuller record.
 *
 * Note this is a weaker claim than requiring both, so everything after it carries
 * the weight: the code goes only to the contacts ON FILE, it is rate limited per
 * identifier and per IP, and attempts are capped. A single identifier never
 * authenticates anyone by itself.
 *
 * Only ACTIVE clients are returned - a dormant account cannot sign in.
 */
async function findClients(identifier) {
  const kind = identifierKind(identifier);
  if (!kind) return [];

  const UCC_MATCH = `(upper(btrim(u.ucc)) = $2 OR upper(btrim(c.ctermcode)) = $2)`;

  let where, params;
  if (kind === 'email') {
    where = `(lower(btrim(COALESCE(u.email,''))) = $1 OR lower(btrim(COALESCE(c.email_id,''))) = $1)`;
    params = [normEmail(identifier)];
  } else if (kind === 'mobile') {
    // Ten digits could be a mobile or a numeric client code — try both, or a client
    // whose UCC happens to be ten digits could never sign in.
    where = `(right(regexp_replace(COALESCE(u.mobile,''),'[^0-9]','','g'),10) = $1
              OR right(regexp_replace(COALESCE(c.mobile,''),'[^0-9]','','g'),10) = $1
              OR ${UCC_MATCH})`;
    params = [normMobile(identifier), normUcc(identifier)];
  } else {
    where = UCC_MATCH.replace(/\$2/g, '$1');
    params = [normUcc(identifier)];
  }

  return ananta.rows(
    `SELECT upper(btrim(u.ucc)) AS ucc,
            COALESCE(NULLIF(btrim(u.name_asper_pan),''), NULLIF(btrim(c.name_asper_pan),''),
                     NULLIF(btrim(u.client_name),''), btrim(c.cclientname)) AS name,
            lower(btrim(COALESCE(NULLIF(btrim(u.email),''), c.email_id))) AS email,
            right(regexp_replace(COALESCE(NULLIF(btrim(u.mobile),''), c.mobile, ''),'[^0-9]','','g'),10) AS mobile,
            c.branch_id
       FROM ${ananta.DWH}.tbl_user_info u
       LEFT JOIN ${ananta.STG}.ask_clientmast c
         ON upper(btrim(c.ctermcode)) = upper(btrim(u.ucc))
      WHERE ${where}
        AND lower(COALESCE(c.cstatus, u.status, '')) = 'active'
        AND upper(COALESCE(c.activation_status,'Y')) = 'Y'
      ORDER BY 1 LIMIT 25`, params);
}

/** Too many requests for one identifier, or from one IP, in the last hour. */
async function throttled(identifier, ip) {
  const key = String(identifier || '').trim().toLowerCase();
  const r = await one(
    `SELECT count(*) FILTER (WHERE mobile = $1)::int AS by_id,
            count(*) FILTER (WHERE ip = $2)::int     AS by_ip
       FROM ${SCHEMA}.ofs_client_otp
      WHERE issued_at > now() - interval '1 hour'`, [key, ip || null]);
  return (r.by_id >= 5) || (r.by_ip >= 20);
}

/** Seconds still to wait before another code may be sent for this identifier. */
async function resendWait(identifier) {
  const r = await one(
    `SELECT extract(epoch FROM (issued_at + ($2 || ' seconds')::interval - now()))::int AS wait
       FROM ${SCHEMA}.ofs_client_otp
      WHERE mobile = $1 ORDER BY issued_at DESC LIMIT 1`,
    [String(identifier || '').trim().toLowerCase(), String(RESEND_COOLDOWN_S)]);
  return r && r.wait > 0 ? r.wait : 0;
}

/**
 * `identifier` is what the client typed (used for throttling and resend); `email`
 * and `mobile` are the contacts ON FILE that the code is actually sent to.
 */
async function createChallenge({ identifier, mobile, email, uccs, ip, userAgent }) {
  const ref = crypto.randomUUID();
  const code = testMode() ? testOtp() : generateOtp();
  const to = [email ? maskEmail(email) : null, mobile ? maskMobile(mobile) : null]
    .filter(Boolean).join(' and ');
  await query(
    `INSERT INTO ${SCHEMA}.ofs_client_otp
       (ref, mobile, email, uccs, otp_hash, max_attempts, delivered_to, channel, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' minutes')::interval, $10,$11)`,
    [ref, String(identifier || '').trim().toLowerCase(), normEmail(email), uccs,
     hash(code), OTP_MAX_ATTEMPTS, to, testMode() ? 'test' : 'both',
     String(OTP_TTL_MIN), ip || null, (userAgent || '').slice(0, 300)]);
  return { ref, code, expiresInMin: OTP_TTL_MIN, sentTo: to };
}

/**
 * Verify a code. Returns { ok, uccs } or { ok:false, reason }.
 * The attempt is counted BEFORE comparison, so a client that crashes mid-request
 * cannot be used to get a free guess.
 */
async function verifyChallenge(ref, code) {
  if (!ref || !code) return { ok: false, reason: 'missing' };

  const row = await one(
    `UPDATE ${SCHEMA}.ofs_client_otp
        SET attempts = attempts + 1
      WHERE ref = $1 AND used_at IS NULL AND attempts < max_attempts AND expires_at > now()
      RETURNING ref, otp_hash, uccs, attempts, max_attempts, mobile, email`, [ref]);

  if (!row) {
    const exists = await one(
      `SELECT used_at, expires_at, attempts, max_attempts FROM ${SCHEMA}.ofs_client_otp WHERE ref = $1`, [ref]);
    if (!exists) return { ok: false, reason: 'unknown' };
    if (exists.used_at) return { ok: false, reason: 'used' };
    if (new Date(exists.expires_at) <= new Date()) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (!hashMatches(code, row.otp_hash)) {
    return { ok: false, reason: 'wrong', attemptsLeft: Math.max(0, row.max_attempts - row.attempts) };
  }

  await query(`UPDATE ${SCHEMA}.ofs_client_otp SET used_at = now() WHERE ref = $1`, [ref]);
  return { ok: true, uccs: row.uccs, mobile: row.mobile, email: row.email };
}

async function logAttempt(d) {
  try {
    await query(
      `INSERT INTO ${SCHEMA}.ofs_client_login_log
         (event, mobile, email, client_ucc, ok, reason, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [d.event, d.mobile ? normMobile(d.mobile) : null, d.email ? normEmail(d.email) : null,
       d.ucc || null, !!d.ok, d.reason || null, d.ip || null, (d.userAgent || '').slice(0, 300)]);
  } catch (e) { console.error('[client-auth] log failed:', e.message); }
}

module.exports = {
  OTP_TTL_MIN, OTP_MAX_ATTEMPTS, RESEND_COOLDOWN_S,
  testMode, testOtp, normMobile, normEmail, hash, generateOtp,
  maskEmail, maskMobile, identifierKind, findClients, throttled, resendWait,
  createChallenge, verifyChallenge, logAttempt
};
