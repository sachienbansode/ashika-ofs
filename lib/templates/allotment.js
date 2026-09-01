'use strict';
/** Allotment result email. Figures only — no advice, and no PII beyond the client's own. */
const { brandedEmail } = require('../emailBranding');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const inr = (n, d) => Number(n || 0).toLocaleString('en-IN',
  { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });

const TD = 'style="padding:6px 10px;border-bottom:1px solid #eaeef2;font-size:13px"';
const TH = 'style="padding:6px 10px;border-bottom:1px solid #eaeef2;font-size:13px;color:#57606a;text-align:left"';

function row(k, v) { return `<tr><th ${TH}>${esc(k)}</th><td ${TD} align="right"><b>${v}</b></td></tr>`; }

/** a: { client_name, client_ucc, symbol, company, bid_qty, bid_price, allot_qty, allot_price, allot_value } */
function allotmentEmail(a) {
  const allotted = Number(a.allot_qty) > 0;
  const inner = `
    <p style="margin:0 0 14px">Dear ${esc(a.client_name || 'Investor')},</p>
    <p style="margin:0 0 16px">
      ${allotted
        ? `Your bid in the <b>${esc(a.symbol)}</b> Offer for Sale has been allotted.`
        : `Your bid in the <b>${esc(a.symbol)}</b> Offer for Sale was not allotted. Any margin blocked against it is released as per the exchange settlement cycle.`}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid #eaeef2;border-radius:6px">
      ${row('Scrip', esc(a.symbol) + (a.company ? ' — ' + esc(a.company) : ''))}
      ${row('Client code (UCC)', esc(a.client_ucc))}
      ${a.bid_qty != null ? row('Quantity bid', inr(a.bid_qty, 0)) : ''}
      ${a.bid_price != null ? row('Price bid', '₹' + inr(a.bid_price)) : ''}
      ${allotted ? row('Quantity allotted', inr(a.allot_qty, 0)) : ''}
      ${allotted && a.allot_price != null ? row('Allotment price', '₹' + inr(a.allot_price)) : ''}
      ${allotted ? row('Allotment value', '₹' + inr(a.allot_value, 2)) : ''}
    </table>
    <p style="margin:16px 0 0;color:#6b7280;font-size:12px">
      Shares are credited to your demat account per the exchange settlement cycle.
      For any query, contact your relationship manager or the Admin desk.
    </p>`;
  return {
    subject: `OFS ${allotted ? 'allotment' : 'bid result'} — ${a.symbol}`,
    html: brandedEmail(inner)
  };
}

module.exports = { allotmentEmail };
