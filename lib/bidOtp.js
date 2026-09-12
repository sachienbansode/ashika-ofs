'use strict';
/**
 * The client's confirmation for a bid someone else placed.
 *
 * Ashika's rule, and the reason it is shaped this way:
 *
 *   client acting for themselves   no code. They proved who they were at sign-in,
 *                                  and a code per edit near a 15:15 cut-off costs
 *                                  bids without proving anything new.
 *   AP / branch / back office      a code to the CLIENT's registered mobile and
 *                                  email, entered before the bid is written.
 *
 * A challenge is bound to the client, the issue, the action and — for a modify or
 * cancel — the bid. So a code the client approved for "cancel my Coal India bid"
 * cannot be spent placing a new one, and a code for one client cannot be spent on
 * another. Binding is checked at redemption, not merely recorded.
 */
const crypto = require('crypto');
const { SCHEMA, query, one } = require('../db/ofsAdapter');
const otp = require('./otp');
const settings = require('./settings');
const ld = require('../db/ldAdapter');
const mailer = require('./mailer');
const sms = require('./sms');
const { brandedEmail } = require('./emailBranding');

const TTL_MIN = Number(process.env.OFS_BID_OTP_TTL_MIN || 10);

/** Does this actor need the client's confirmation? A client acting alone does not. */
function required(actorKind) {
  return actorKind === 'desk' || actorKind === 'ap' || actorKind === 'branch';
}

const ACTION_WORDS = {
  place: 'place a bid',
  modify: 'change a bid',
  cancel: 'withdraw a bid'
};

function confirmEmail(name, code, action, issue, detail, who, mins) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, '');
  return brandedEmail(`
    <p style="margin:0 0 14px">Dear ${esc(name || 'Investor')},</p>
    <p style="margin:0 0 14px">
      ${esc(who)} is trying to <b>${esc(ACTION_WORDS[action] || action)}</b> on your behalf
      in <b>${esc(issue)}</b>${detail ? ' — ' + esc(detail) : ''}.</p>
    <p style="margin:0 0 18px">If that is what you want, share this code with them:</p>
    <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:700;
                letter-spacing:.22em;color:#243f8e;background:#f2f7fb;border:1px solid #e2ecf2;
                border-radius:10px;padding:16px;text-align:center;margin:0 0 18px">${esc(code)}</div>
    <p style="margin:0 0 6px;color:#6b7f9e;font-size:12px">
      It expires in ${esc(mins)} minutes and can be used once, for this action only.</p>
    <p style="margin:0;color:#6b7f9e;font-size:12px">
      <b>If you did not ask for this, do not share the code</b> and tell Ashika.
      Nothing can be placed in your name without it.</p>`);
}

/**
 * Issue a challenge and send it to the client's own contacts — read from LD, never
 * from the request. The point of the code is that it reaches the client, so the
 * person asking for it must not be able to say where it goes.
 */
async function create({ clientUcc, issueId, action, bidId, requestedBy, requestedByKind,
                        issueLabel, detail, ip, userAgent }) {
  const client = await ld.findByUcc(clientUcc);
  if (!client) return { ok: false, reason: 'unknown_client' };
  if (!client.email && !client.mobile) {
    return { ok: false, reason: 'no_contact',
      message: 'This client has no registered email or mobile on file, so they cannot confirm a bid. '
             + 'Ask them to update their contact details before bidding on their behalf.' };
  }

  const ref = crypto.randomUUID();
  // The mode is a SETTING now, floored by the server environment — see
  // lib/otp.js resolveMode. Read here rather than at module load so a change in
  // Masters > Settings takes effect on the next code, not the next restart.
  const fixed = otp.testMode(await settings.all());
  const code = fixed ? otp.testOtp() : otp.generateOtp();
  const to = [client.email ? otp.maskEmail(client.email) : null,
              client.mobile ? otp.maskMobile(client.mobile) : null].filter(Boolean).join(' and ');

  await query(
    `INSERT INTO ${SCHEMA}.ofs_bid_otp
       (ref, client_ucc, issue_id, action, bid_id, otp_hash, max_attempts, delivered_to,
        channel, requested_by, requested_by_kind, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' minutes')::interval, $13,$14)`,
    [ref, ld.norm(clientUcc), issueId, action, bidId || null, otp.hash(code), otp.OTP_MAX_ATTEMPTS,
     to, fixed ? 'test' : 'both', String(requestedBy || '').slice(0, 200),
     requestedByKind, String(TTL_MIN), ip || null, String(userAgent || '').slice(0, 300)]);

  const out = { ok: true, ref, sent_to: to, ttl_minutes: TTL_MIN, client_name: client.name };

  if (fixed) {
    console.warn('[bid-otp] TEST MODE - fixed code, nothing sent');
    out.test_mode = true;
    out.test_code = code;
    return out;
  }

  const results = await Promise.all([
    client.email
      ? mailer.send({ to: client.email, subject: 'Confirm an OFS bid on your account',
          html: confirmEmail(client.name, code, action, issueLabel || 'an Offer for Sale',
                             detail, requestedBy, TTL_MIN),
          purpose: 'ofs_bid_confirm', triggeredBy: requestedByKind, ip })
      : Promise.resolve({ sent: false, reason: 'no_email_on_file' }),
    client.mobile
      ? sms.send({ to: client.mobile,
          text: `${code} is your Ashika OFS confirmation code to ${ACTION_WORDS[action] || action}. `
              + `Valid ${TTL_MIN} min. Share only with Ashika if you asked for this.` })
      : Promise.resolve({ sent: false, reason: 'no_mobile_on_file' })
  ]);

  out.delivered = results.some((r) => r.sent);
  if (!out.delivered) {
    return { ok: false, reason: 'send_failed',
      message: 'We could not reach the client to confirm. Try again shortly.' };
  }
  return out;
}

const VERIFY_MSG = {
  missing: 'Enter the code the client received.',
  unknown: 'That confirmation is no longer valid. Request a new code.',
  used: 'That code has already been used. Request a new one.',
  expired: 'That code has expired. Request a new one.',
  too_many_attempts: 'Too many incorrect attempts. Request a new code.',
  wrong: 'That code is not correct.',
  mismatch: 'That code was issued for a different client, issue or action.'
};

/**
 * Redeem a code for exactly the action it was issued for.
 *
 * The attempt is counted before the comparison, so a caller that drops the
 * connection mid-request cannot buy a free guess. The binding is checked after the
 * code matches, so a wrong guess never reveals what the code was for.
 */
async function verify({ ref, code, clientUcc, issueId, action, bidId }) {
  if (!ref || !code) return { ok: false, reason: 'missing' };

  const row = await one(
    `UPDATE ${SCHEMA}.ofs_bid_otp
        SET attempts = attempts + 1
      WHERE ref = $1 AND used_at IS NULL AND attempts < max_attempts AND expires_at > now()
      RETURNING ref, client_ucc, issue_id, action, bid_id, otp_hash, attempts, max_attempts`, [ref]);

  if (!row) {
    const e = await one(
      `SELECT used_at, expires_at, attempts, max_attempts FROM ${SCHEMA}.ofs_bid_otp WHERE ref = $1`, [ref]);
    if (!e) return { ok: false, reason: 'unknown' };
    if (e.used_at) return { ok: false, reason: 'used' };
    if (new Date(e.expires_at) <= new Date()) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (!otp.hashMatches(code, row.otp_hash)) {
    return { ok: false, reason: 'wrong', attemptsLeft: Math.max(0, row.max_attempts - row.attempts) };
  }

  const sameBid = row.bid_id == null || bidId == null
    ? row.bid_id == null && (bidId == null || action === 'place')
    : String(row.bid_id) === String(bidId);
  const bound = ld.norm(row.client_ucc) === ld.norm(clientUcc)
    && String(row.issue_id) === String(issueId)
    && row.action === action
    && sameBid;

  if (!bound) return { ok: false, reason: 'mismatch' };

  await query(`UPDATE ${SCHEMA}.ofs_bid_otp SET used_at = now() WHERE ref = $1`, [ref]);
  return { ok: true, ref: row.ref };
}

function message(reason) { return VERIFY_MSG[reason] || 'Confirmation failed.'; }

module.exports = { TTL_MIN, required, create, verify, message, VERIFY_MSG, ACTION_WORDS };
