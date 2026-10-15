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
const settings = require('../lib/settings');
const ba = require('../lib/branchAuth');
const cs = require('../middleware/clientAuth');
const branches = require('../db/branchAdapter');
const mailer = require('../lib/mailer');
const { otpEmail } = require('../lib/templates/otp');

const router = express.Router();

const startLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

const ipOf = (req) => (req.ip || '').replace(/^::ffff:/, '') || null;


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

    // One read, one verdict: calling testMode() three times could straddle a
    // settings change and store a fixed code while telling the caller it was real.
    const fixed = ca.testMode(await settings.all());
    const code = fixed ? ca.testOtp() : ca.generateOtp();
    const ref = crypto.randomUUID();
    const to = ca.maskEmail(email);

    await query(
      `INSERT INTO ${SCHEMA}.ofs_client_otp
         (ref, mobile, email, uccs, branch_codes, actor_type, otp_hash, max_attempts,
          delivered_to, channel, expires_at, ip, user_agent)
       VALUES ($1,NULL,$2,NULL,$3,'branch',$4,$5,$6,$7, now() + ($8 || ' minutes')::interval, $9,$10)`,
      [ref, email, eligible.map((b) => b.branch_code), ca.hash(code), ca.OTP_MAX_ATTEMPTS,
       to, fixed ? 'test' : 'email', String(ca.OTP_TTL_MIN), ip, ua.slice(0, 300)]);

    const out = {
      ok: true, ref, sent_to: to, email,
      ttl_minutes: ca.OTP_TTL_MIN, resend_after_s: ca.RESEND_COOLDOWN_S,
      // Shown so the person knows which code they are about to sign in as. Safe:
      // they already hold the mailbox these branches publish.
      branches: eligible.map((b) => branchCard(b)),
      message: 'A code has been sent to the email registered for this branch.'
    };

    if (fixed) {
      console.warn('[branch-auth] TEST MODE — fixed code, nothing sent');
      out.test_mode = true;
      out.test_code = code;
      await ca.logAttempt({ event: 'otp_sent', email, ip, userAgent: ua, ok: true, reason: 'test_mode' });
      return res.json(out);
    }

    const sent = await mailer.send({
      to: email, subject: 'Your Ashika OFS sign-in code',
      html: otpEmail({ name: eligible[0].contact_person || eligible[0].branch_name, code: code,
                       minutes: ca.OTP_TTL_MIN,
                       expiresAt: new Date(Date.now() + ca.OTP_TTL_MIN * 60000),
                       audience: 'branch' }),
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

/**
 * One branch, as the chooser has to show it.
 *
 * The code alone is not enough to choose by. A live address came back holding both
 * K005 and KO05 — letter O against digit zero, the same firm name on both — and
 * the two buttons were indistinguishable on screen. Whoever is signing in cannot
 * pick the right one from a string they cannot tell apart, so the city and the
 * firm number ride along and the screen sets the code in a monospaced face, where
 * 0 and O are different shapes.
 */
function branchCard(b) {
  return {
    code: b.branch_code,
    name: b.branch_name,
    city: b.city || null,
    firm: b.firm || null,
    type: ba.actorTypeOf(b),
    type_label: ba.actorLabel(ba.actorTypeOf(b))
  };
}

/* How long the chooser ticket lives. Long enough to read two lines and click,
 * short enough that an abandoned one is worthless. */
const CHOOSE_TTL_MIN = 5;

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
    /* A code is spent the moment it verifies — ca.verifyChallenge sets used_at, and
     * it must, or a code could be replayed.
     *
     * This asked the browser to call verify AGAIN with the branch it had chosen,
     * using the same code. The second call could only ever answer "That code has
     * already been used. Please request a new one." — so no address registered
     * against more than one branch code could sign in AT ALL, and requesting a new
     * code just repeated the loop.
     *
     * The client door solved this long ago: when a verified code resolves to more
     * than one account it issues a short-lived chooser ticket and the browser
     * calls /select with that. The branch door now does the same thing, which is
     * also why the list of candidates cannot be widened by the request - the
     * ticket carries the codes the OTP was issued for. */
    const code = candidates.length === 1 ? candidates[0] : null;
    if (!code) {
      const choose = crypto.randomUUID();
      await query(
        `INSERT INTO ${SCHEMA}.ofs_client_otp
           (ref, mobile, email, uccs, branch_codes, actor_type, otp_hash, max_attempts,
            channel, expires_at, ip, user_agent, used_at)
         VALUES ($1,NULL,$2,NULL,$3,'branch','chooser',0,'test',
                 now() + ($4 || ' minutes')::interval, $5, $6, now())`,
        [choose, r.email, candidates, String(CHOOSE_TTL_MIN), ip, ua.slice(0, 300)]);
      const cards = (await branches.findMany(candidates)).map(branchCard);
      return res.status(200).json({ ok: true, choose_branch: true, choose,
        branch_codes: candidates, branches: cards });
    }
    return res.json(await signIn(res, code, r.email, ip, ua));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.code, message: e.message });
    console.error('[branch-auth] verify failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /client/auth/branch/select { choose, branch_code }
 *
 * Only reachable with a chooser ticket, which is only issued against a code that
 * has already verified. The branch must be one the ticket carries: the request
 * cannot nominate a branch of its own, exactly as the verify step could not.
 */
router.post('/select', verifyLimiter, async (req, res) => {
  const ip = ipOf(req);
  const ua = req.headers['user-agent'] || '';
  try {
    const wanted = branches.normCode((req.body || {}).branch_code);
    const row = await one(
      `SELECT email, branch_codes FROM ${SCHEMA}.ofs_client_otp
        WHERE ref = $1 AND otp_hash = 'chooser' AND actor_type = 'branch' AND expires_at > now()`,
      [(req.body || {}).choose]);
    if (!row) {
      return res.status(401).json({ error: 'unknown',
        message: 'That sign-in attempt is no longer valid. Please request a new code.' });
    }
    if (!wanted || (row.branch_codes || []).indexOf(wanted) < 0) {
      return res.status(403).json({ error: 'not_your_branch',
        message: 'That branch was not one of the options for this sign-in.' });
    }
    return res.json(await signIn(res, wanted, row.email, ip, ua));
  } catch (e) {
    /* A disabled or closed branch is a 403 with a sentence, not a server fault —
       raised inside signIn so verify and select cannot answer it differently. */
    if (e.status) return res.status(e.status).json({ error: e.code, message: e.message });
    console.error('[branch-auth] select failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * The last checks, then the session — shared by verify (one branch) and select
 * (several), so a chosen branch is never checked less thoroughly than a sole one.
 */
async function signIn(res, code, email, ip, ua) {
  // Re-checked against LD and the override NOW, not at the moment the code was
  // sent: a branch closed in the last five minutes must not get in.
  const branch = await branches.findByCode(code);
  const blocked = await branches.blockedCodes();
  const block = ba.loginBlock(branch, blocked);
  if (block) {
    await ca.logAttempt({ event: 'otp_failed', email, ip, userAgent: ua, ok: false, reason: block });
    const e = new Error(ba.blockMessage(block));
    e.status = 403; e.code = block;
    throw e;
  }
  return establish(res, branch, email, ip, ua);
}

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
