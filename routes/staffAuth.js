'use strict';
/**
 * Direct back-office sign-in — the fallback door to /backoffice when portal SSO is not
 * (yet) deployed. See lib/staffAuth.js for why it exists and what it must not weaken.
 *
 *   POST /auth/staff/login   { email, password }  -> session cookie, or { mfa_required, ref }
 *   POST /auth/staff/verify  { ref, code }        -> session cookie
 *
 * Credentials belong to the platform: "admin-staging-api".users / roles in the
 * Ananta DB. OFS stores no staff password and creates no staff account.
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { T, adminOne, adminQuery } = require('../db/adminAdapter');
const { SCHEMA, query, one } = require('../db/ofsAdapter');
const sa = require('../lib/staffAuth');
const otp = require('../lib/otp');
const mailer = require('../lib/mailer');
const { brandedEmail } = require('../lib/emailBranding');
const audit = require('../lib/audit');
const staffSession = require('../lib/staffSession');

const router = express.Router();

const COOKIE = process.env.SESSION_COOKIE || 'ofs_session';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: String(process.env.COOKIE_SECURE || (process.env.NODE_ENV === 'production')) === 'true',
  sameSite: 'lax',
  path: '/',
  maxAge: 8 * 60 * 60 * 1000
};

// Password guessing is the whole threat here, so the limit is tight and per-IP.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

const ipOf = (req) => (req.ip || '').replace(/^::ffff:/, '') || null;

/** One message for every credential failure — never "no such user". */
const BAD_CREDS = { error: 'invalid_credentials', message: 'Email or password is incorrect.' };

/**
 * Compare against a dummy hash when the account does not exist, so a missing user
 * and a wrong password take the same time. Without this the endpoint answers
 * "unknown email" in a millisecond and "wrong password" in eighty.
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.6.qKcQjV0dQnO6dLdD/pTh0R8mVQrLu';

async function loadStaff(email) {
  return adminOne(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.password_hash,
            u.is_active, u.mfa_enabled, u.auth_provider,
            u.role_id AS "roleId", r.name AS role, r.requires_mfa, r.use_m365, r.permissions
       FROM ${T('users')} u
       JOIN ${T('roles')} r ON r.id = u.role_id
      WHERE lower(u.email) = lower($1)`, [String(email || '').trim()]);
}

/**
 * Start a session.
 *
 * This used to rotate users.active_sid — the platform column the Stage API portal
 * also rotates — so signing in here ended the portal session and vice versa. The
 * session now lives in ofs.ofs_staff_session; single-session still holds within OFS
 * (open() revokes this user's other OFS sessions) and the portal is left alone.
 *
 * last_login_at is still stamped: it is a fact about the account, not a session
 * handle, and the portal's own screens read it.
 */
async function issueSession(res, user, req) {
  await adminQuery(`UPDATE ${T('users')} SET last_login_at = NOW() WHERE id = $1`, [user.id]);
  const jti = await staffSession.open(user, req, Number(process.env.OFS_STAFF_TTL_HOURS || 8));

  const token = jwt.sign({
    sub: user.id, id: user.id, email: user.email,
    firstName: user.first_name, lastName: user.last_name,
    roleId: user.roleId, role: user.role,
    permissions: { pages: sa.pagesOf(user.permissions) },
    jti
  }, process.env.JWT_SECRET, {
    issuer: process.env.JWT_ISSUER || undefined,
    expiresIn: process.env.JWT_EXPIRES_IN || '8h'
  });

  res.cookie(COOKIE, token, COOKIE_OPTS);
  await audit.log({ user: { email: user.email, id: user.id }, ip: req.ip },
    'staff_login', 'session', String(user.id), null, { role: user.role, via: 'password' });
  return { ok: true, user: { id: user.id, email: user.email, role: user.role } };
}

function otpEmail(name, code, mins) {
  return brandedEmail(`
    <p style="margin:0 0 14px">Hello ${String(name || 'there').replace(/[&<>]/g, '')},</p>
    <p style="margin:0 0 18px">Use this code to sign in to the Ashika OFS BackOffice:</p>
    <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:700;
                letter-spacing:.22em;color:#243f8e;background:#f2f7fb;border:1px solid #e2ecf2;
                border-radius:10px;padding:16px;text-align:center;margin:0 0 18px">${code}</div>
    <p style="margin:0 0 6px;color:#6b7f9e;font-size:12px">
      This code expires in ${mins} minutes and can be used once.</p>
    <p style="margin:0;color:#6b7f9e;font-size:12px">
      If this was not you, your password may be known to someone else — change it in the portal.</p>`);
}

/**
 * The back-office code is REAL, even while client codes are still fixed for UAT.
 *
 * Staff addresses are real Ashika mailboxes that exist today, and this door leads to
 * every client's PII and to the exchange files. A fixed code here would be a shared
 * password, not a test convenience — so staffTestMode() is off unless someone opts
 * out explicitly, the opposite default from the client side.
 */
async function startMfa(req, user) {
  const ref = crypto.randomUUID();
  const testing = otp.staffTestMode();
  const code = testing ? otp.testOtp() : otp.generateOtp();
  const to = otp.maskEmail(user.email);

  await query(
    `INSERT INTO ${SCHEMA}.ofs_staff_otp
       (ref, user_id, email, otp_hash, max_attempts, delivered_to, channel, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval, $9,$10)`,
    [ref, user.id, otp.normEmail(user.email), otp.hash(code), otp.OTP_MAX_ATTEMPTS, to,
     testing ? 'test' : 'email', String(otp.OTP_TTL_MIN), ipOf(req),
     (req.headers['user-agent'] || '').slice(0, 300)]);

  const out = { mfa_required: true, ref, sent_to: to, ttl_minutes: otp.OTP_TTL_MIN };

  if (testing) {
    console.warn('[staff-auth] TEST MODE - fixed code, nothing sent');
    out.test_mode = true;
    out.test_code = code;
    return out;
  }

  const r = await mailer.send({
    to: user.email, subject: 'Your Ashika OFS BackOffice sign-in code',
    html: otpEmail(user.first_name, code, otp.OTP_TTL_MIN),
    purpose: 'ofs_staff_otp', triggeredBy: 'desk-signin', ip: ipOf(req)
  });
  if (!r.sent) {
    // Say what actually failed. "Sign-in failed" when SMTP is down sends the desk
    // hunting for a password problem that does not exist.
    const e = new Error(r.error || 'otp_send_failed');
    e.code = 'OTP_SEND_FAILED';
    throw e;
  }
  return out;
}

/** POST /auth/staff/login */
router.post('/login', loginLimiter, async (req, res) => {
  if (!sa.directLoginEnabled()) {
    return res.status(403).json({ error: 'direct_login_disabled',
      message: 'Sign in at the portal and open the OFS desk from there.' });
  }

  const email = String((req.body && req.body.email) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'invalid_input', message: 'Enter your email and password.' });
  }

  try {
    const user = await loadStaff(email);
    const block = sa.directLoginBlock(user);

    // Always spend the bcrypt round, even for an unknown or password-less account.
    const ok = await bcrypt.compare(password, (user && user.password_hash) || DUMMY_HASH);

    if (block === 'm365') {
      return res.status(403).json({ error: 'use_portal',
        message: 'This account signs in with Microsoft 365. Use the portal, then open the OFS desk from there.' });
    }
    if (block || !ok) {
      await audit.log({ user: { email }, ip: req.ip }, 'staff_login_failed', 'session', null, null,
        { reason: block || 'bad_password' });
      return res.status(401).json(BAD_CREDS);
    }

    // Nothing on the desk is reachable without a grant, so refuse here rather than
    // handing out a session that can only see an empty gate.
    if (!sa.hasDeskGrant(user.permissions)) {
      return res.status(403).json({ error: 'no_ofs_access',
        message: 'Your ' + (user.role || 'assigned') + ' role does not include the OFS desk. '
               + 'An administrator grants the "ofs-desk" page to the role.' });
    }

    if (sa.needsMfa(user)) return res.json(await startMfa(req, user));
    return res.json(await issueSession(res, user, req));
  } catch (e) {
    if (e.code === 'OTP_SEND_FAILED') {
      return res.status(503).json({ error: 'otp_send_failed',
        message: 'We could not send your code just now. Please try again shortly.' });
    }
    console.error('[staff-auth] login failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

const VERIFY_MSG = {
  missing: 'Enter the 6-digit code.',
  unknown: 'That sign-in attempt is no longer valid. Please start again.',
  used: 'That code has already been used. Please sign in again.',
  expired: 'That code has expired. Please sign in again.',
  too_many_attempts: 'Too many incorrect attempts. Please sign in again.',
  wrong: 'That code is not correct.'
};

/** POST /auth/staff/verify */
router.post('/verify', verifyLimiter, async (req, res) => {
  const ref = String((req.body && req.body.ref) || '');
  const code = String((req.body && req.body.code) || '').trim();
  if (!ref || !code) return res.status(400).json({ error: 'missing', message: VERIFY_MSG.missing });

  try {
    // The attempt is counted before the comparison, so a caller that drops the
    // connection mid-request cannot buy itself a free guess.
    const row = await one(
      `UPDATE ${SCHEMA}.ofs_staff_otp
          SET attempts = attempts + 1
        WHERE ref = $1 AND used_at IS NULL AND attempts < max_attempts AND expires_at > now()
        RETURNING ref, user_id, otp_hash, attempts, max_attempts`, [ref]);

    if (!row) {
      const ex = await one(`SELECT used_at, expires_at FROM ${SCHEMA}.ofs_staff_otp WHERE ref = $1`, [ref]);
      const reason = !ex ? 'unknown'
        : ex.used_at ? 'used'
        : new Date(ex.expires_at) <= new Date() ? 'expired' : 'too_many_attempts';
      return res.status(401).json({ error: reason, message: VERIFY_MSG[reason] });
    }

    if (!otp.hashMatches(code, row.otp_hash)) {
      return res.status(401).json({ error: 'wrong', message: VERIFY_MSG.wrong,
        attempts_left: Math.max(0, row.max_attempts - row.attempts) });
    }

    await query(`UPDATE ${SCHEMA}.ofs_staff_otp SET used_at = now() WHERE ref = $1`, [ref]);

    // Re-read the account: a grant revoked or an account disabled between the two
    // requests must take effect now, not at the next login.
    const user = await adminOne(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active, u.role_id AS "roleId",
              r.name AS role, r.permissions
         FROM ${T('users')} u JOIN ${T('roles')} r ON r.id = u.role_id
        WHERE u.id = $1`, [row.user_id]);

    if (!user || user.is_active === false) return res.status(401).json(BAD_CREDS);
    if (!sa.hasDeskGrant(user.permissions)) {
      return res.status(403).json({ error: 'no_ofs_access',
        message: 'Your role does not include the OFS desk.' });
    }

    return res.json(await issueSession(res, user, req));
  } catch (e) {
    console.error('[staff-auth] verify failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
