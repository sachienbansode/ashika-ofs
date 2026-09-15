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

function confirmEmail(name, code, action, issue, detail, who, mins, ucc) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, '');
  return brandedEmail(`
    <p style="margin:0 0 14px">Dear ${esc(name || 'Investor')},</p>
    ${ucc ? `<p style="margin:0 0 14px;color:#6b7f9e;font-size:13px">
      Client code <b style="color:#243f8e;font-family:ui-monospace,Menlo,Consolas,monospace">${esc(ucc)}</b></p>` : ''}
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
/**
 * The material terms of a bid, reduced to one string.
 *
 * This is what the client is agreeing to, so it has to be exactly the fields that
 * decide what leaves their account — category, quantity, price (or the fact that
 * it is a cut-off bid), and which exchange it goes to. Not the reference, not who
 * typed it, not the time: those can differ between the request for the code and
 * the write without the client having been misled.
 *
 * Numbers are normalised so that 400, '400' and 400.0000 are one value — the
 * browser sends a string, the database returns a numeric, and a hash that changed
 * between them would refuse every honest bid.
 */
function termsOf(t) {
  if (!t) return null;
  const n = (v) => (v == null || v === '' ? '' : String(Number(v)));
  const cut = t.is_cutoff === true || String(t.is_cutoff) === 'true';
  return [
    String(t.category || '').trim(),
    n(t.qty),
    cut ? 'CUTOFF' : n(t.price),
    String(t.exchange || '').trim().toUpperCase()
  ].join('|');
}

/** Hash of the terms, or null when there are none to bind (a cancellation). */
function termsHash(t) {
  const s = termsOf(t);
  return s ? crypto.createHash('sha256').update(s).digest('hex') : null;
}

async function create({ clientUcc, issueId, action, bidId, requestedBy, requestedByKind,
                        issueLabel, detail, terms, ip, userAgent }) {
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
        channel, requested_by, requested_by_kind, expires_at, ip, user_agent, terms_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' minutes')::interval, $13,$14,$15)`,
    [ref, ld.norm(clientUcc), issueId, action, bidId || null, otp.hash(code), otp.OTP_MAX_ATTEMPTS,
     to, fixed ? 'test' : 'both', String(requestedBy || '').slice(0, 200),
     requestedByKind, String(TTL_MIN), ip || null, String(userAgent || '').slice(0, 300),
     action === 'cancel' ? null : termsHash(terms)]);

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
                             detail, requestedBy, TTL_MIN, client.ucc || clientUcc),
          purpose: 'ofs_bid_confirm', triggeredBy: requestedByKind, ip })
      : Promise.resolve({ sent: false, reason: 'no_email_on_file' }),
    client.mobile
      ? sms.send({ to: client.mobile,
          text: `${code} is your Ashika OFS confirmation code to ${ACTION_WORDS[action] || action} `
              + `for ${ld.norm(clientUcc)}. `
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
  mismatch: 'That code was issued for a different client, issue or action.',
  terms_changed: 'The bid has changed since the client confirmed it. '
    + 'Send a new code showing the client the bid you are placing now.'
};

/**
 * Redeem a code for exactly the action it was issued for.
 *
 * The attempt is counted before the comparison, so a caller that drops the
 * connection mid-request cannot buy a free guess. The binding is checked after the
 * code matches, so a wrong guess never reveals what the code was for.
 */
async function verify({ ref, code, clientUcc, issueId, action, bidId, terms }) {
  if (!ref || !code) return { ok: false, reason: 'missing' };

  const row = await one(
    `UPDATE ${SCHEMA}.ofs_bid_otp
        SET attempts = attempts + 1
      WHERE ref = $1 AND used_at IS NULL AND attempts < max_attempts AND expires_at > now()
      RETURNING ref, client_ucc, issue_id, action, bid_id, otp_hash, attempts, max_attempts,
                terms_hash`, [ref]);

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

  /* And bound to the AMOUNT the client was shown.
   *
   * Without this, a code approved for "500 shares at ₹400" could be spent on
   * 20,000 shares for the same client on the same issue — and ofs_bid.otp_verified
   * would then assert the client had agreed to it. A cancellation has no terms, and
   * a code issued before migration 022 has no hash; in both cases there is nothing
   * to compare and the bindings that do exist have already been checked. */
  if (row.terms_hash) {
    const want = termsHash(terms);
    if (!want || want !== row.terms_hash) return { ok: false, reason: 'terms_changed' };
  }

  await query(`UPDATE ${SCHEMA}.ofs_bid_otp SET used_at = now() WHERE ref = $1`, [ref]);
  return { ok: true, ref: row.ref };
}

function message(reason) { return VERIFY_MSG[reason] || 'Confirmation failed.'; }

module.exports = { TTL_MIN, required, create, verify, message, VERIFY_MSG, ACTION_WORDS,
  termsOf, termsHash };
