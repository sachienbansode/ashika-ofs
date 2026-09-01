'use strict';
/**
 * OFS domain rules, ported from the ashika-ofs-bidding.html prototype so the
 * server enforces exactly what the prototype validated client-side.
 * SEBI/exchange mechanics: T-day = Non-Retail (HNI), T+1 = Retail; floor price
 * gates Non-Retail; Retail bids at / above the cut-off price; Retail <= Rs 2 lakh.
 */

const CATS = ['Retail', 'HNI'];

function win(issue, cat) {
  return cat === 'HNI'
    ? { open: issue.hni_open, close: issue.hni_close }
    : { open: issue.ret_open, close: issue.ret_close };
}

/** Minimum acceptable price for a category: Retail uses cut_price_min, HNI the floor. */
function minPrice(issue, cat) {
  const floor = Number(issue.floor_price) || 0;
  if (cat === 'Retail') {
    const cm = issue.cut_price_min == null ? floor : Number(issue.cut_price_min);
    return cm > 0 ? cm : floor;
  }
  return floor;
}

/** Upcoming | Open | Closed | Suspended - for one category. */
function catStatus(issue, cat, now) {
  now = now || new Date();
  if (issue.status === 'Suspended') return 'Suspended';
  if (issue.status === 'Closed') return 'Closed';
  const w = win(issue, cat);
  const o = new Date(w.open), c = new Date(w.close);
  if (now < o) return 'Upcoming';
  if (now > c) return 'Closed';
  return 'Open';
}

/** Overall issue status for the dashboard chip. */
function issueStatus(issue, now) {
  const r = catStatus(issue, 'Retail', now), h = catStatus(issue, 'HNI', now);
  if (h === 'Open' && r === 'Open') return 'Both open';
  if (h === 'Open') return 'HNI open';
  if (r === 'Open') return 'Retail open';
  if (h === 'Upcoming' || r === 'Upcoming') return 'Upcoming';
  return 'Closed';
}

function isMultiple(v, step) {
  if (!step) return true;
  const q = Number(v) / Number(step);
  return Math.abs(q - Math.round(q)) < 1e-6;
}

/**
 * Desk daily cut-off (HH:MM IST). Compared in Asia/Kolkata explicitly - the app
 * server runs UTC, so never use the host's local hours here.
 */
const IST_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
});

function istMinutes(now) {
  const parts = IST_FMT.formatToParts(now || new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function pastDailyCutoff(cutoffHHMM, now) {
  const [h, m] = String(cutoffHHMM || '15:15').split(':').map(Number);
  return istMinutes(now) > ((h || 15) * 60 + (m || 15));
}

function bidValue(issue, cat, qty, price, isCutoff) {
  const p = isCutoff ? minPrice(issue, cat) : Number(price) || 0;
  return (Number(qty) || 0) * p;
}

/**
 * Full server-side validation. Returns an array of human-readable errors.
 * ctx = { settings, availableMargin, marginUsed, usedValueThisIssue, hasLiveBid, now }
 */
function validateBid(issue, bid, ctx) {
  const e = [];
  const s = ctx.settings || {};
  const now = ctx.now || new Date();
  const cat = bid.category;

  if (!CATS.includes(cat)) { e.push('Choose Retail or HNI bidding.'); return e; }

  if (ctx.hasLiveBid && !bid.editingId) {
    e.push('A live bid already exists for ' + issue.symbol + ' for this client. Modify or cancel it - only one bid per scrip is allowed.');
  }

  const st = catStatus(issue, cat, now);
  if (st !== 'Open') e.push(cat + ' bidding for ' + issue.symbol + ' is ' + st.toLowerCase() + '.');
  if (pastDailyCutoff(s.daily_cutoff, now)) {
    e.push('The daily cut-off of ' + (s.daily_cutoff || '15:15') + ' has passed. No further bids are accepted today.');
  }

  const lot = Number(issue.lot) || 1;
  const qty = Number(bid.qty) || 0;
  if (qty < 1) e.push('Enter a quantity of at least ' + lot + ' share(s).');
  else if (!isMultiple(qty, lot)) e.push('Quantity must be a multiple of ' + lot + '.');

  const mp = minPrice(issue, cat);
  if (!bid.is_cutoff) {
    const p = Number(bid.price) || 0;
    const tick = Number(issue.tick) || 0.05;
    if (!p) e.push('Enter a bid price.');
    else if (p < mp - 1e-9) e.push('Cannot bid below ' + mp.toFixed(2) + ' for ' + issue.symbol + '.');
    else if (!isMultiple(Math.round(p * 100) / 100, tick)) e.push('Bid price must be in multiples of the ' + tick + ' tick size.');
  } else if (cat === 'HNI') {
    e.push('Cut-off bidding is not available to Non-Retail (HNI) bidders.');
  } else if (issue.cutoff_flag === false) {
    e.push('Cut-off bidding is not enabled for ' + issue.symbol + '.');
  }

  const val = bidValue(issue, cat, qty, bid.price, bid.is_cutoff);

  if (cat === 'HNI') {
    const hniMin = Number(s.hni_min) || 0;
    if (hniMin && val < hniMin - 1e-6) {
      e.push('An HNI bid must be at least ' + hniMin + ' - that is ' + Math.ceil(hniMin / mp) + ' shares at ' + mp.toFixed(2) + '.');
    }
  } else {
    const cap = Number(s.retail_cap) || 0;
    if (cap) {
      const tot = (Number(ctx.usedValueThisIssue) || 0) + val;
      if (tot > cap + 1e-6) {
        e.push('Retail bids in ' + issue.symbol + ' cannot exceed ' + cap + ' in total. This bid takes it to ' + Math.round(tot) + '.');
      }
    }
  }

  const av = Number(ctx.availableMargin) || 0;
  if (av <= 0) {
    e.push('Available margin is 0, so no bid can be placed for this client.');
  } else if (Number(s.enforce_margin) === 1) {
    const free = av - (Number(ctx.marginUsed) || 0);
    if (val > free + 1e-6) e.push('Bid value ' + Math.round(val) + ' is above the free margin of ' + Math.round(Math.max(0, free)) + '.');
  }

  return e;
}

function makeRef(prefix) {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const stamp = String(n.getFullYear()).slice(2) + p(n.getMonth() + 1) + p(n.getDate());
  return (prefix || 'OFS') + stamp + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

module.exports = { CATS, win, minPrice, catStatus, issueStatus, isMultiple, istMinutes, pastDailyCutoff, bidValue, validateBid, makeRef };
