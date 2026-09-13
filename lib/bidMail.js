'use strict';
/**
 * Order confirmation for a bid, to the client and to whoever acted.
 *
 * Off by default. It is switched on from Masters → Settings, and the screen asks
 * the desk to confirm before it goes on, because switching it on starts sending
 * mail to real investors — on a UAT database full of production addresses, that is
 * the kind of mistake nobody gets to take back.
 *
 * Three rules this module keeps:
 *
 *   A bid is never lost to a mail problem. Every path returns rather than throws,
 *   and the caller does not await the result — a dead SMTP host, a client with no
 *   address on file, a template error: none of them may turn an accepted bid into
 *   a 500, because the bid is already committed by the time we get here.
 *
 *   The client's copy is the important one; the actor's is a copy. They are sent
 *   as two separate messages rather than one with two recipients, so an AP never
 *   sees the client's address in a To: line they did not already have, and so the
 *   email log records each delivery separately.
 *
 *   Nothing is sent to an address the request supplied. The client's comes from
 *   the client master, the actor's from their signed-in session. A confirmation
 *   that could be redirected by the person placing the bid would be worth nothing
 *   as a record.
 */
const { SCHEMA, one } = require('../db/ofsAdapter');
const settings = require('./settings');
const mailer = require('./mailer');
const ld = require('../db/ldAdapter');
const { bidConfirmEmail } = require('./templates/bidConfirm');

/** Off unless the desk has explicitly turned it on. */
async function enabled(s) {
  const cfg = s || await settings.all();
  return String(cfg.bid_email_confirm == null ? '0' : cfg.bid_email_confirm) === '1';
}

/** Who acted, and where their copy goes — from the SESSION, never from the body. */
function actorOf(req) {
  const u = req && req.user;
  if (u && (u.email || u.id)) {
    return { email: u.email || null, who: String(u.email || u.id) };
  }
  const p = (req && req.portal) || {};
  if (p.kind === 'ap' || p.kind === 'branch') {
    return { email: p.loginEmail || null, who: p.branchCode || p.kind };
  }
  // A client acting for themselves: the confirmation IS their copy, so there is
  // no second one to send.
  return { email: null, who: p.ucc || 'client' };
}

const looksLikeEmail = (v) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(v || '').trim());

/**
 * Send the confirmation. Never throws; returns what happened, for the caller's
 * audit line and for tests.
 *
 * bid    the row as written, straight from insertBid/updateBid/cancelBid
 * action 'place' | 'modify' | 'cancel'
 * issue  the issue row from the bid's context, for the scrip name
 */
async function sendBidConfirm(req, bid, action, issue) {
  try {
    if (!bid || !bid.client_ucc) return { sent: false, reason: 'no_bid' };
    if (!(await enabled())) return { sent: false, reason: 'disabled' };

    /* A withdrawal has no context object to hand — the route only loaded the bid
     * row, and that carries no scrip name. "Your bid in the Offer for Sale has
     * been withdrawn" would be a poor thing to send, so the name is fetched.
     * One small read, on a path that has already committed. */
    let scrip = issue;
    if (!scrip && bid.issue_id) {
      scrip = await one(`SELECT symbol, company FROM ${SCHEMA}.ofs_issue WHERE id = $1`,
        [bid.issue_id]).catch(() => null);
    }

    const el = await ld.eligibility(bid.client_ucc);
    const c = (el && el.client) || {};
    const actor = actorOf(req);
    const copyTo = looksLikeEmail(actor.email) ? String(actor.email).trim() : null;

    const model = Object.assign({}, bid, {
      client_name: c.name || null,
      symbol: (scrip && scrip.symbol) || bid.symbol || null,
      company: (scrip && scrip.company) || bid.company || null
    });

    const out = { sent: false, client: null, copy: null };

    if (looksLikeEmail(c.email)) {
      const msg = bidConfirmEmail(model, action, { copyTo: copyTo });
      const r = await mailer.send({ to: String(c.email).trim(), subject: msg.subject,
        html: msg.html, purpose: 'ofs_bid_confirm', triggeredBy: actor.who,
        ip: req && req.ip });
      out.client = r.sent ? 'sent' : (r.error || 'failed');
      out.sent = !!r.sent;
    } else {
      // Worth recording: a client with no address on file gets no confirmation,
      // and the desk should find that out from the log rather than from the client.
      out.client = 'no_address';
    }

    // The actor's copy. Not sent when the actor IS the client — they already have it.
    if (copyTo && copyTo.toLowerCase() !== String(c.email || '').trim().toLowerCase()) {
      const msg = bidConfirmEmail(model, action, {});
      const r = await mailer.send({ to: copyTo, subject: msg.subject, html: msg.html,
        purpose: 'ofs_bid_confirm_copy', triggeredBy: actor.who, ip: req && req.ip });
      out.copy = r.sent ? 'sent' : (r.error || 'failed');
    }
    return out;
  } catch (e) {
    // Deliberately swallowed. The bid is already committed; a mail failure must
    // never be reported to the user as a failed bid.
    console.warn('[bidMail] confirmation not sent:', e && e.message);
    return { sent: false, reason: 'error', error: e && e.message };
  }
}

module.exports = { sendBidConfirm, enabled, actorOf };
