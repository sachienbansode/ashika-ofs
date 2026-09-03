'use strict';
/**
 * OFS domain rules, ported from the ashika-ofs-bidding.html prototype so the
 * server enforces exactly what the prototype validated client-side.
 * SEBI/exchange mechanics: T-day = Non-Retail (HNI), T+1 = Retail; floor price
 * gates Non-Retail; Retail bids at / above the cut-off price; Retail <= Rs 2 lakh.
 */

const { marketState, closedMessage } = require('./marketHours');

const CATS = ['Retail', 'HNI'];

function win(issue, cat) {
  return cat === 'HNI'
    ? { open: issue.hni_open, close: issue.hni_close }
    : { open: issue.ret_open, close: issue.ret_close };
}

/** Minimum acceptable price for a category: Retail uses cut_price_min, HNI the floor. */
/**
 * The lowest price this category may bid, or NULL when there is no published floor.
 *
 * NSE's e-OFS FAQ v3.0 Q12 is explicit that the floor price "is not declared to the
 * market & is informed to the designated exchange one day prior". Disclosure is the
 * seller's choice, so an OFS can legitimately run with no floor we know of, and the
 * exchange applies it at matching instead.
 *
 * NULL is deliberately not 0. Returning 0 would read as "any price clears", and the
 * old code did exactly that — Number(undefined) || 0 — so a missing floor silently
 * became a floor of zero.
 */
function minPrice(issue, cat) {
  const floor = issue.floor_price == null || issue.floor_price === ''
    ? null : Number(issue.floor_price);
  if (floor != null && !(floor > 0)) return null;

  if (cat === 'Retail') {
    const cm = issue.cut_price_min == null || issue.cut_price_min === ''
      ? null : Number(issue.cut_price_min);
    if (cm != null && cm > 0) return cm;
  }
  return floor;
}

/** Has the seller published a floor for this issue? */
function floorDisclosed(issue) {
  return minPrice(issue, 'HNI') != null;
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

/**
 * What a bid is worth for margin and cap purposes.
 *
 * A cut-off bid is valued at the floor — that is what the exchange blocks margin
 * against (BSE 20150122-30 §4.3.5). With no published floor there is no figure to
 * value it at, so this returns null and the caller must say so rather than treating
 * an unknown as zero and waving the bid through every cap and margin check.
 */
function bidValue(issue, cat, qty, price, isCutoff) {
  const p = isCutoff ? minPrice(issue, cat) : Number(price) || 0;
  if (p == null) return null;
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

  // Client eligibility, from LD. Catching this here means an ineligible UCC is
  // refused at bid time rather than coming back as an exchange rejection after the
  // desk has already uploaded the file.
  if (ctx.client) {
    if (ctx.client.found === false) e.push('No client found for that UCC.');
    else if (ctx.client.active === false) {
      e.push('Client ' + (bid.client_ucc || '') + ' is not active' +
        (ctx.client.status ? ' (' + ctx.client.status + ')' : '') + ' and cannot bid.');
    }
  }

  const st = catStatus(issue, cat, now);
  if (st !== 'Open') e.push(cat + ' bidding for ' + issue.symbol + ' is ' + st.toLowerCase() + '.');

  // A bid may only be placed while the market is open, and the desk cut-off
  // overrides the session end — see lib/marketHours.js.
  const mkt = marketState(s, now);
  if (!mkt.open) e.push(closedMessage(mkt));

  const lot = Number(issue.lot) || 1;
  const qty = Number(bid.qty) || 0;
  if (qty < 1) e.push('Enter a quantity of at least ' + lot + ' share(s).');
  else if (!isMultiple(qty, lot)) e.push('Quantity must be a multiple of ' + lot + '.');

  const mp = minPrice(issue, cat);
  if (!bid.is_cutoff) {
    const p = Number(bid.price) || 0;
    const tick = Number(issue.tick) || 0.05;
    if (!p) e.push('Enter a bid price.');
    // With no published floor there is nothing to compare against; the exchange
    // applies its own at matching. Rejecting here would refuse every valid bid.
    else if (mp != null && p < mp - 1e-9) {
      e.push('Cannot bid below ' + mp.toFixed(2) + ' for ' + issue.symbol + '.');
    }
    else if (!isMultiple(Math.round(p * 100) / 100, tick)) e.push('Bid price must be in multiples of the ' + tick + ' tick size.');
  } else if (cat === 'HNI') {
    e.push('Cut-off bidding is not available to Non-Retail (HNI) bidders.');
  } else if (issue.cutoff_flag === false) {
    e.push('Cut-off bidding is not enabled for ' + issue.symbol + '.');
  }

  const val = bidValue(issue, cat, qty, bid.price, bid.is_cutoff);

  /* A cut-off bid on an undisclosed-floor issue has no value we can compute, so the
     ₹2 lakh cap and the HNI minimum cannot be checked. Say so instead of passing an
     unchecked bid: the cap is a SEBI limit, and quietly skipping it is worse than
     refusing the bid. A price bid is unaffected — its value is the price. */
  if (val == null) {
    e.push('The floor price for ' + issue.symbol + ' has not been published, so a cut-off bid '
         + 'cannot be valued against the ' + (cat === 'HNI' ? 'HNI minimum' : 'retail cap')
         + '. Place a price bid instead, or wait for the desk to enter the floor price.');
  } else if (cat === 'HNI') {
    const hniMin = Number(s.hni_min) || 0;
    if (hniMin && val < hniMin - 1e-6) {
      const shares = mp != null && mp > 0 ? ' - that is ' + Math.ceil(hniMin / mp) + ' shares at ' + mp.toFixed(2) : '';
      e.push('An HNI bid must be at least ' + hniMin + shares + '.');
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
    // val is null only when the floor is undisclosed, which is already reported
    // above; do not compare null against a margin and call it a pass.
    if (val != null && val > free + 1e-6) {
      e.push('Bid value ' + Math.round(val) + ' is above the free margin of ' + Math.round(Math.max(0, free)) + '.');
    }
  }

  return e;
}

function makeRef(prefix) {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const stamp = String(n.getFullYear()).slice(2) + p(n.getMonth() + 1) + p(n.getDate());
  return (prefix || 'OFS') + stamp + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

module.exports = { CATS, win, minPrice, floorDisclosed, catStatus, issueStatus, isMultiple, istMinutes,
  pastDailyCutoff, marketState, closedMessage, bidValue, validateBid, makeRef };
