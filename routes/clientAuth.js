'use strict';
/**
 * Client sign-in: mobile + email, then a one-time code.
 *
 * The Ashika website simply links here; there is no SSO token to trust, so this
 * app establishes the identity itself. Deliberate behaviours:
 *
 *  - The start endpoint answers IDENTICALLY whether or not the pair matched, so it
 *    cannot be used to discover which mobile/email combinations are clients.
 *  - The code is emailed to the address ON FILE, never to one supplied in the form.
 *  - A client with several UCCs (families share an email) picks one after the code
 *    is verified, never before — the list is not shown to an unverified visitor.
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { SCHEMA, query, rows, one } = require('../db/ofsAdapter');
const ca = require('../lib/clientAuth');
const cs = require('../middleware/clientAuth');
const mailer = require('../lib/mailer');
const { brandedEmail } = require('../lib/emailBranding');
const ld = require('../db/ldAdapter');

const router = express.Router();

const startLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

const ipOf = (req) => (req.ip || '').replace(/^::ffff:/, '') || null;

function otpEmail(name, code, mins) {
  return brandedEmail(`
    <p style="margin:0 0 14px">Dear ${String(name || 'Investor').replace(/[&<>]/g, '')},</p>
    <p style="margin:0 0 18px">Use this code to sign in to the Ashika OFS bidding module:</p>
    <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:700;
                letter-spacing:.22em;color:#243f8e;background:#f2f7fb;border:1px solid #e2ecf2;
                border-radius:10px;padding:16px;text-align:center;margin:0 0 18px">${code}</div>
    <p style="margin:0 0 6px;color:#6b7f9e;font-size:12px">
      This code expires in ${mins} minutes and can be used once.</p>
    <p style="margin:0;color:#6b7f9e;font-size:12px">
      If you did not request it, ignore this email — no one can sign in without it.
      Ashika will never ask you for this code by phone or message.</p>`);
}

/** POST /client/auth/start { mobile, email } */
router.post('/start', startLimiter, async (req, res) => {
  const mobile = ca.normMobile(req.body && req.body.mobile);
  const email = ca.normEmail(req.body && req.body.email);
  const ip = ipOf(req);
  const ua = req.headers['user-agent'] || '';

  if (mobile.length !== 10 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_input',
      message: 'Enter a 10-digit mobile number and the email address registered with your account.' });
  }

  // The generic answer. Every path below returns exactly this on the happy side,
  // so a caller learns nothing about whether the pair exists.
  const generic = {
    ok: true,
    ttl_minutes: ca.OTP_TTL_MIN,
    resend_after_s: ca.RESEND_COOLDOWN_S,
    message: 'If those details match an active account, a code has been sent to the registered email address.'
  };

  try {
    if (await ca.throttled(mobile, ip)) {
      await ca.logAttempt({ event: 'blocked', mobile, email, ip, userAgent: ua, reason: 'throttled' });
      return res.status(429).json({ error: 'too_many_requests',
        message: 'Too many sign-in attempts. Please try again later.' });
    }

    const wait = await ca.resendWait(mobile);
    if (wait > 0) return res.status(429).json({ error: 'resend_cooldown', retry_after_s: wait,
      message: `Please wait ${wait}s before requesting another code.` });

    const clients = await ca.findClients(mobile, email);
    await ca.logAttempt({ event: 'otp_requested', mobile, email, ip, userAgent: ua,
      ok: clients.length > 0, reason: clients.length ? null : 'no_match' });

    if (!clients.length) return res.json(generic);          // deliberately indistinguishable

    const ch = await ca.createChallenge({
      mobile, email, uccs: clients.map((c) => c.ucc), ip, userAgent: ua });

    const out = Object.assign({ ref: ch.ref, sent_to: ca.maskEmail(clients[0].email || email) }, generic);

    if (ca.testMode()) {
      // Non-production only (lib/clientAuth.testMode checks NODE_ENV), so the desk
      // can be exercised without a mailbox. Returned so the UI can show it.
      console.warn('[client-auth] TEST MODE — fixed OTP in use, no email sent');
      out.test_mode = true;
      out.test_code = ch.code;
      await ca.logAttempt({ event: 'otp_sent', mobile, email, ip, userAgent: ua, ok: true, reason: 'test_mode' });
      return res.json(out);
    }

    const r = await mailer.send({
      to: clients[0].email || email,
      subject: 'Your Ashika OFS sign-in code',
      html: otpEmail(clients[0].name, ch.code, ch.expiresInMin),
      purpose: 'ofs_client_otp', triggeredBy: 'client-signin', ip });

    await ca.logAttempt({ event: 'otp_sent', mobile, email, ip, userAgent: ua,
      ok: r.sent, reason: r.sent ? null : r.error });

    if (!r.sent) return res.status(503).json({ error: 'otp_send_failed',
      message: 'We could not send the code just now. Please try again shortly.' });

    return res.json(out);
  } catch (e) {
    console.error('[client-auth] start failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

const VERIFY_MSG = {
  missing: 'Enter the 6-digit code.',
  unknown: 'That sign-in attempt is no longer valid. Please start again.',
  used: 'That code has already been used. Please request a new one.',
  expired: 'That code has expired. Please request a new one.',
  too_many_attempts: 'Too many incorrect attempts. Please request a new code.',
  wrong: 'That code is not correct.'
};

/** POST /client/auth/verify { ref, otp } */
router.post('/verify', verifyLimiter, async (req, res) => {
  const ref = req.body && req.body.ref;
  const otp = String((req.body && req.body.otp) || '').replace(/\D/g, '');
  const ip = ipOf(req);
  const ua = req.headers['user-agent'] || '';

  try {
    const r = await ca.verifyChallenge(ref, otp);
    if (!r.ok) {
      await ca.logAttempt({ event: 'otp_failed', ip, userAgent: ua, ok: false, reason: r.reason });
      return res.status(401).json({ error: r.reason,
        message: VERIFY_MSG[r.reason] || 'Sign-in failed.',
        attempts_left: r.attemptsLeft });
    }

    // More than one UCC on the same mobile+email: verified, but not yet told which
    // account. The chooser is only reachable with a redeemed code.
    if (r.uccs.length > 1) {
      const list = await ld.findMany(r.uccs);
      const choose = crypto.randomUUID();
      await query(
        `INSERT INTO ${SCHEMA}.ofs_client_otp
           (ref, mobile, email, uccs, otp_hash, max_attempts, channel, expires_at, ip, user_agent, used_at)
         VALUES ($1,$2,$3,$4,'chooser',0,'test', now() + interval '5 minutes', $5,$6, now())`,
        [choose, r.mobile, r.email, r.uccs, ip, ua.slice(0, 300)]);
      return res.json({
        ok: true, choose: choose,
        accounts: r.uccs.map((u) => {
          const c = list.get(u);
          return { ucc: u, name: (c && c.name) || null, branch: (c && c.branch_id) || null };
        })
      });
    }

    return res.json(await establish(res, r.uccs[0], ip, ua));
  } catch (e) {
    console.error('[client-auth] verify failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

/** POST /client/auth/select { choose, ucc } — only after a verified code. */
router.post('/select', verifyLimiter, async (req, res) => {
  const ip = ipOf(req);
  const ua = req.headers['user-agent'] || '';
  try {
    const row = await one(
      `SELECT uccs FROM ${SCHEMA}.ofs_client_otp
        WHERE ref = $1 AND otp_hash = 'chooser' AND expires_at > now()`,
      [req.body && req.body.choose]);
    if (!row) return res.status(401).json({ error: 'unknown', message: 'Please sign in again.' });

    const ucc = ld.norm(req.body && req.body.ucc);
    if (!row.uccs.includes(ucc)) return res.status(403).json({ error: 'not_your_account' });

    await query(`DELETE FROM ${SCHEMA}.ofs_client_otp WHERE ref = $1`, [req.body.choose]);
    return res.json(await establish(res, ucc, ip, ua));
  } catch (e) {
    console.error('[client-auth] select failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

/** Create the session row, set the cookie, and describe the signed-in client. */
async function establish(res, ucc, ip, ua) {
  const jti = crypto.randomUUID();
  const hours = Number(process.env.CLIENT_SESSION_HOURS || 2);
  await query(
    `INSERT INTO ${SCHEMA}.ofs_client_session
       (jti, client_ucc, actor_type, expires_at, ip, user_agent)
     VALUES ($1,$2,'client', now() + ($3 || ' hours')::interval, $4,$5)`,
    [jti, ucc, String(hours), ip, (ua || '').slice(0, 300)]);

  res.cookie(cs.COOKIE, cs.sign({ ucc, typ: 'client' }, jti, hours), cs.cookieOpts());
  await ca.logAttempt({ event: 'login', ucc, ip, userAgent: ua, ok: true });

  const c = await ld.findByUcc(ucc);
  return {
    ok: true,
    client: { ucc, name: (c && c.name) || null, email: c ? ca.maskEmail(c.email) : null,
              mobile: c ? ca.maskMobile(c.mobile) : null, branch: (c && c.branch_id) || null }
  };
}

/** GET /client/auth/me */
router.get('/me', cs.requireClient, async (req, res, next) => {
  try {
    const c = await ld.findByUcc(req.client.ucc);
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json({
      client: { ucc: c.ucc, name: c.name, email: ca.maskEmail(c.email), mobile: ca.maskMobile(c.mobile),
                branch: c.branch_id, category: c.category },
      actor_type: req.client.actorType
    });
  } catch (e) { next(e); }
});

router.post('/logout', cs.requireClient, async (req, res) => {
  await query(`UPDATE ${SCHEMA}.ofs_client_session SET revoked_at = now() WHERE jti = $1`, [req.client.jti])
    .catch(() => {});
  await ca.logAttempt({ event: 'logout', ucc: req.client.ucc, ip: ipOf(req), ok: true });
  res.clearCookie(cs.COOKIE, Object.assign({}, cs.cookieOpts(), { maxAge: undefined }));
  res.json({ ok: true });
});

module.exports = router;
