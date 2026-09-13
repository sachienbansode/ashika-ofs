'use strict';
/**
 * Order confirmation for a bid placed, changed or withdrawn.
 *
 * Sent to the CLIENT, and copied to whoever acted — the back-office user, the
 * branch or the Authorised Partner. Both need it and for different reasons: the
 * client needs a record of what was done in their name, and the person who did it
 * needs proof they told them.
 *
 * Two things this email must never do. It must not read as a contract note — the
 * bid is with the desk, not at the exchange, and the standing condition from
 * lib/notices says so in the same words the screen used. And it must not carry PII
 * the recipient does not already hold: the client's own name and UCC, the bid, and
 * nothing else. No PAN, no mobile, no margin figure, no other client.
 */
const { brandedEmail } = require('../emailBranding');
const notices = require('../notices');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n, d) => Number(n || 0).toLocaleString('en-IN',
  { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });

const TD = 'style="padding:7px 10px;border-bottom:1px solid #eaeef2;font-size:13px"';
const TH = 'style="padding:7px 10px;border-bottom:1px solid #eaeef2;font-size:13px;color:#57606a;text-align:left;font-weight:400"';

function row(k, v) {
  return `<tr><th ${TH}>${esc(k)}</th><td ${TD} align="right"><b>${v}</b></td></tr>`;
}

/** IST, always — the server runs UTC and a confirmation timed in UTC is worse than none. */
function istStamp(v) {
  const d = v ? new Date(v) : new Date();
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d).replace(',', '') + ' IST';
}

const HEADINGS = {
  place:  { verb: 'placed',   title: 'Bid confirmation',  lead: 'has been placed' },
  modify: { verb: 'changed',  title: 'Bid changed',       lead: 'has been changed' },
  cancel: { verb: 'withdrawn', title: 'Bid withdrawn',    lead: 'has been withdrawn' }
};

/** Who did it, in words the client will recognise. Never an internal identifier. */
function actorPhrase(placedBy) {
  switch (String(placedBy || '').toLowerCase()) {
    case 'client': return 'by you, on the OFS portal';
    case 'ap':     return 'by your Authorised Partner';
    case 'branch': return 'by your branch';
    case 'desk':   return 'by the Ashika OFS desk on your instruction';
    default:       return 'on your account';
  }
}

/**
 * b: { ref, client_ucc, client_name, symbol, company, category, qty, price,
 *      is_cutoff, value, exchange, status, placed_by, created_at, updated_at }
 * action: 'place' | 'modify' | 'cancel'
 * opts:   { copyTo }  — the address this was copied to, named in the footer so the
 *         client can see who else has it.
 */
function bidConfirmEmail(b, action, opts) {
  const h = HEADINGS[action] || HEADINGS.place;
  const o = opts || {};
  const cancelled = action === 'cancel';

  const inner = `
    <h2 style="margin:0 0 12px;font-size:17px;color:#243f8e">${esc(h.title)}</h2>
    <p style="margin:0 0 14px">Dear ${esc(b.client_name || 'Investor')},</p>
    <p style="margin:0 0 16px">
      Your bid in the <b>${esc(b.symbol || '')}</b> Offer for Sale ${h.lead},
      ${actorPhrase(b.placed_by)}.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
           style="border-collapse:collapse;border:1px solid #eaeef2;border-radius:6px">
      ${row('Application reference', esc(b.ref))}
      ${row('Client code (UCC)', esc(b.client_ucc))}
      ${row('Scrip', esc(b.symbol || '') + (b.company ? ' — ' + esc(b.company) : ''))}
      ${row('Category', esc(b.category === 'Retail' ? 'Retail' : 'Non-Retail (HNI)'))}
      ${row('Quantity', inr(b.qty, 0) + ' shares')}
      ${row('Price', b.is_cutoff ? 'Cut-off price' : '₹' + inr(b.price))}
      ${b.value != null ? row('Bid value', '₹' + inr(b.value)) : ''}
      ${b.exchange ? row('Exchange', esc(b.exchange)) : ''}
      ${row(cancelled ? 'Withdrawn at' : 'Recorded at', esc(istStamp(b.updated_at || b.created_at)))}
    </table>
    ${cancelled
      ? `<p style="margin:16px 0 0">This bid has been withdrawn and will not be submitted to the
           exchange. Any margin held against it is released.</p>`
      : `<p style="margin:16px 0 0;padding:11px 13px;background:#f4f7fc;border-left:3px solid #243f8e;
           border-radius:4px;font-size:13px">${esc(notices.BID_ACCEPTED_EMAIL)}</p>`}
    <p style="margin:16px 0 0;color:#6b7280;font-size:12px">
      Quote the application reference above in any query about this bid.
      ${o.copyTo ? 'A copy of this confirmation has been sent to ' + esc(o.copyTo) + '.' : ''}
      If you did not authorise this, contact the Ashika OFS desk immediately.
    </p>`;

  return {
    subject: `${h.title} — ${b.symbol || 'Offer for Sale'} · ${b.ref}`,
    html: brandedEmail(inner)
  };
}

module.exports = { bidConfirmEmail, istStamp, actorPhrase };
