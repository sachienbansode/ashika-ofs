'use strict';
/**
 * Branch / Authorised Partner sign-in: the email on the LD branchho record, then a
 * one-time code sent to that record — never to the address typed in the form.
 *
 * Mounted under the same /client/auth prefix as the client journey, and it issues
 * the same kind of session cookie, because from the browser's point of view this is
 * the same portal with a different door. What differs is the scope: a client session
 * is bound to one UCC, a branch session to a BRANCHCODE, and every list and write is
 * filtered by whichever it is.
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { SCHEMA, query, one } = require('../db/ofsAdapter');
const ca = require('../lib/clientAuth');
const ba = require('../lib/branchAuth');
const cs = require('../middleware/clientAuth');
const branches = require('../db/branchAdapter');
const mailer = require('../lib/mailer');
const { brandedEmail } = require('../lib/emailBranding');

const router = express.Router();

const startLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

const ipOf = (req) => (req.ip || '').replace(/^::ffff:/, '') || null;

function otpEmail(name, code, mins) {
  return brandedEmail(`
    <p style="margin:0 0 14px">Hello ${String(name || 'there').replace(/[&<>]/g, '')},</p>
    <p style="margin:0 0 18px">Use this code to sign in to the Ashika OFS bidding module:</p>
    <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:700;
                letter-spacing:.22em;color:#243f8e;background:#f2f7fb;border:1px solid #e2ecf2;
                border-radius:10px;padding:16px;text-align:center;margin:0 0 18px">${code}</div>
    <p style="margin:0 0 6px;color:#6b7f9e;font-size:12px">
      This code expires in ${mins} minutes and can be used once.</p>
    <p style="margin:0;color:#6b7f9e;font-size:12px">
      If you did not request it, ignore this email. Ashika will never ask you for this code.</p>`);
}

/**
 * POST /client/auth/branch/start { email }
 *
 * Unlike the client door this one names the failure. A branch email is a business
 * address already published on contract notes and the member list, so refusing to
 * say "that address is not registered" protects nothing and costs the desk a
 * support call every time someone mistypes.
 */
router.post('/start', startLimiter, async (req, res) => {
  const email = branches.normEmail((req.body || {}).email);
  const ip = ipOf(req);
  const ua = req.headers['user-agent'] || '';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_input',
      message: 'Enter the email address registered for your branch or AP code.' });
  }

  try {
    if (await ca.throttled(email, ip)) {
      await ca.logAttempt({ event: 'blocked', email, ip, userAgent: ua, reason: 'throttled' });
      return res.status(429).json({ error: 'too_many_requests',
        message: 'Too many sign-in attempts. Please try again later.' });
    }
    const wait = await ca.resendWait(email);
    if (wait > 0) return res.status(429).json({ error: 'resend_cooldown', retry_after_s: wait,
      message: `Please wait ${wait}s before requesting another code.` });

    const found = await branches.findByEmail(email);
    const blocked = await branches.blockedCodes();
    const eligible = ba.eligibleBranches(found, blocked);

    if (!eligible.length) {
      // Say which of the two it is: "not registered" and "disabled by the desk" send
      // the person to completely different places.
      const reason = found.length ? ba.loginBlock(found[0], blocked) : 'unknown_branch';
      await ca.logAttempt({ event: 'otp_requested', email, ip, userAgent: ua, ok: false, reason });
      return res.status(reason === 'login_disabled' ? 403 : 404).json({
        error: reason, email, message: ba.blockMessage(reason) });
    }

    const code = ca.testMode() ? ca.testOtp() : ca.generateOtp();
    const ref = crypto.randomUUID();
    const to = ca.maskEmail(email);

    await query(
      `INSERT INTO ${SCHEMA}.ofs_client_otp
         (ref, mobile, email, uccs, branch_codes, actor_type, otp_hash, max_attempts,
          delivered_to, channel, expires_at, ip, user_agent)
       VALUES ($1,NULL,$2,NULL,$3,'branch',$4,$5,$6,$7, now() + ($8 || ' minutes')::interval, $9,$10)`,
      [ref, email, eligible.map((b) => b.branch_code), ca.hash(code), ca.OTP_MAX_ATTEMPTS,
       to, ca.testMode() ? 'test' : 'email', String(ca.OTP_TTL_MIN), ip, ua.slice(0, 300)]);

    const out = {
      ok: true, ref, sent_to: to, email,
      ttl_minutes: ca.OTP_TTL_MIN, resend_after_s: ca.RESEND_COOLDOWN_S,
      // Shown so the person knows which code they are about to sign in as. Safe:
      // they already hold the mailbox these branches publish.
      branches: eligible.map((b) => ({
        code: b.branch_code, name: b.branch_name,
        type: ba.actorTypeOf(b), type_label: ba.actorLabel(ba.actorTypeOf(b)) })),
      message: 'A code has been sent to the email registered for this branch.'
    };

    if (ca.testMode()) {
      console.warn('[branch-auth] TEST MODE — fixed code, nothing sent');
      out.test_mode = true;
      out.test_code = code;
      await ca.logAttempt({ event: 'otp_sent', email, ip, userAgent: ua, ok: true, reason: 'test_mode' });
      return res.json(out);
    }

    const sent = await mailer.send({
      to: email, subject: 'Your Ashika OFS sign-in code',
      html: otpEmail(eligible[0].contact_person || eligible[0].branch_name, code, ca.OTP_TTL_MIN),
      purpose: 'ofs_branch_otp', triggeredBy: 'branch-signin', ip });

    await ca.logAttempt({ event: 'otp_sent', email, ip, userAgent: ua, ok: !!sent.sent,
      reason: sent.sent ? null : (sent.error || 'send_failed') });
    if (!sent.sent) return res.status(503).json({ error: 'otp_send_failed',
      message: 'We could not send the code just now. Please try again shortly.' });

    return res.json(out);
  } catch (e) {
    console.error('[branch-auth] start failed:', e.message);
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

/** POST /client/auth/branch/verify { ref, otp, branch_code? } */
router.post('/verify', verifyLimiter, async (req, res) => {
  const ip = ipOf(req);
  const ua = req.headers['user-agent'] || '';
  const wanted = branches.normCode((req.body || {}).branch_code);

  try {
    const r = await ca.verifyChallenge((req.body || {}).ref, String((req.body || {}).otp || '').replace(/\D/g, ''));
    if (!r.ok) {
      await ca.logAttempt({ event: 'otp_failed', ip, userAgent: ua, ok: false, reason: r.reason });
      return res.status(401).json({ error: r.reason, message: VERIFY_MSG[r.reason] || 'Sign-in failed.',
        attempts_left: r.attemptsLeft });
    }
    if (r.actorType !== 'branch') {
      return res.status(400).json({ error: 'wrong_door',
        message: 'That code was issued for a client sign-in.' });
    }

    const candidates = r.branchCodes || [];
    if (!candidates.length) return res.status(403).json({ error: 'no_branch' });

    // The branch must be one the code was issued for. Sending another code here is
    // the obvious attack, and the list was fixed before the code was sent.
    const code = candidates.length === 1 ? candidates[0] : wanted;
    if (!code) {
      return res.status(200).json({ ok: true, choose_branch: true, branch_codes: candidates });
    }
    if (candidates.indexOf(code) < 0) {
      return res.status(403).json({ error: 'not_your_branch',
        message: 'That branch was not one of the options for this sign-in.' });
    }

    // Re-check against LD and the override at the moment of issue, not at the moment
    // the code was sent: a branch closed in the last five minutes must not get in.
    const branch = await branches.findByCode(code);
    const blocked = await branches.blockedCodes();
    const block = ba.loginBlock(branch, blocked);
    if (block) {
      await ca.logAttempt({ event: 'otp_failed', email: r.email, ip, userAgent: ua, ok: false, reason: block });
      return res.status(403).json({ error: block, message: ba.blockMessage(block) });
    }

    return res.json(await establish(res, branch, r.email, ip, ua));
  } catch (e) {
    console.error('[branch-auth] verify failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

/** Open the branch session and describe it. */
async function establish(res, branch, email, ip, ua) {
  const jti = crypto.randomUUID();
  const hours = Number(process.env.CLIENT_SESSION_HOURS || 2);
  const actorType = ba.actorTypeOf(branch);

  await query(
    `INSERT INTO ${SCHEMA}.ofs_client_session
       (jti, client_ucc, actor_type, branch_code, branch_name, login_email, expires_at, ip, user_agent)
     VALUES ($1, NULL, $2, $3, $4, $5, now() + ($6 || ' hours')::interval, $7, $8)`,
    [jti, actorType, branch.branch_code, branch.branch_name, email, String(hours), ip, (ua || '').slice(0, 300)]);

  res.cookie(cs.COOKIE,
    cs.sign({ typ: actorType, branch: branch.branch_code }, jti, hours),
    cs.cookieOpts());

  await ca.logAttempt({ event: 'login', email, ip, userAgent: ua, ok: true,
    reason: ba.actorLabel(actorType) + ' ' + branch.branch_code });

  const uccs = await branches.uccsOfBranch(branch.branch_code);
  return {
    ok: true,
    branch: {
      code: branch.branch_code, name: branch.branch_name,
      type: actorType, type_label: ba.actorLabel(actorType),
      city: branch.city || null, client_count: uccs.length
    }
  };
}

module.exports = router;
