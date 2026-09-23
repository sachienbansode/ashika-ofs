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

/**
 * Which exchanges this desk is live on.
 *
 * Ashika may be enabled at one exchange and not the other — e-OFS at NSE and the
 * BSE OFS module are separate enablements, and either can be pending, suspended or
 * simply not taken. Bidding on an exchange we cannot upload to produces a bid that
 * sits in the book until somebody notices it was never in any file, so the desk
 * says which exchanges are live and everything downstream obeys it.
 *
 * The setting holds 'NSE', 'BSE' or 'NSE,BSE'. Anything unreadable — an empty
 * string, a typo, a value from an older build — means BOTH, because a setting
 * nobody has touched must not be the thing that silently stops trading.
 */
function allowedExchanges(settings) {
  const raw = String((settings || {}).allowed_exchanges || '').toUpperCase();
  const list = raw.split(/[^A-Z]+/).filter((x) => x === 'NSE' || x === 'BSE');
  const uniq = Array.from(new Set(list));
  return uniq.length ? uniq : ['NSE', 'BSE'];
}

/** Is this exchange one the desk can upload to today? */
function exchangeAllowed(settings, exch) {
  const e = String(exch || '').toUpperCase();
  return allowedExchanges(settings).indexOf(e) >= 0;
}

/**
 * The exchanges a bid on THIS issue may go to: where the issue is listed, narrowed
 * by where the desk is live.
 *
 * An issue on BOTH with only BSE enabled is biddable, at BSE. An issue on NSE alone
 * with only BSE enabled is not biddable at all — and it is a real case, because the
 * issue master is populated from both exchanges' circulars whatever we are enabled
 * for.
 */
function exchangesFor(issue, settings) {
  const on = String((issue && issue.exchange) || '').toUpperCase();
  const listed = on === 'BOTH' ? ['NSE', 'BSE'] : (on === 'NSE' || on === 'BSE') ? [on] : [];
  const ok = allowedExchanges(settings);
  return listed.filter((x) => ok.indexOf(x) >= 0);
}

/** Can a bid be placed on this issue at all, given where the desk is live? */
function issueTradable(issue, settings) {
  return exchangesFor(issue, settings).length > 0;
}

/** Why not — in words a client can read, with no internal names in them. */
function notTradableMessage(issue, settings) {
  if (issueTradable(issue, settings)) return null;
  const on = String((issue && issue.exchange) || '').toUpperCase();
  const sym = (issue && issue.symbol) || 'This offer';
  if (!on) return sym + ' has no exchange set yet, so bids cannot be accepted for it.';
  return sym + ' is offered on ' + on + ' only, and bids are not being accepted on ' +
    on + ' at present. Please contact the OFS desk.';
}

/**
 * The exchange a bid should carry, given the issue and what was asked for.
 * Returns null when the issue is on BOTH and nothing was chosen — the one case
 * where the answer is genuinely unknown and must not be invented.
 */
function bidExchange(issue, wanted) {
  const on = String((issue && issue.exchange) || '').toUpperCase();
  const w = String(wanted || '').toUpperCase();
  if (on === 'NSE' || on === 'BSE') return on;
  return w === 'NSE' || w === 'BSE' ? w : null;
}

/** Upcoming | Open | Closed | Suspended - for one category. */
/* The IST calendar day a moment falls on. */
const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
});

/** The same IST day as `when`, at HH:MM IST. */
function atIstTime(when, hhmm, fallback) {
  const d = when instanceof Date ? when : new Date(when);
  if (isNaN(d)) return d;
  const t = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(hhmm || '')) ? String(hhmm) : fallback;
  return new Date(IST_DAY.format(d) + 'T' + t + ':00+05:30');
}

/**
 * When a category is really open: the issue record says which DAYS, the desk
 * cut-off in Settings says the TIME bidding stops on them.
 *
 * Two goes at this. The cut-off began as one desk-wide time that closed every
 * offer, which refused bids an offer was still open for. It was then changed to
 * the time typed on the issue - and since a new issue defaults to closing at
 * 15:15, the setting stopped having any effect at all and nothing the admin did
 * could move it. Neither is what the desk needs.
 *
 * So: the issue decides the days, the admin decides the hour. Raise the cut-off
 * and every open offer takes bids until then; lower it and the desk stops early,
 * which is what a cut-off is for. The open time is left exactly as it was typed -
 * an offer that starts at 11:00 still starts at 11:00.
 */
function effectiveWin(issue, cat, settings) {
  const w = win(issue, cat);
  return {
    open: new Date(w.open),
    close: settings ? atIstTime(w.close, settings.daily_cutoff, SESSION_CLOSE) : new Date(w.close)
  };
}

function catStatus(issue, cat, now, settings) {
  now = now || new Date();
  if (issue.status === 'Suspended') return 'Suspended';
  if (issue.status === 'Closed') return 'Closed';
  const w = effectiveWin(issue, cat, settings);
  if (now < w.open) return 'Upcoming';
  if (now > w.close) return 'Closed';
  return 'Open';
}

/**
 * Was this category open at any point during a given IST calendar day?
 *
 * catStatus answers "right now", which is the wrong question when the screen is
 * showing a past date: an issue whose window ran 09:15–15:15 on the 11th is Closed
 * now and was open all day then. A day is a span, not an instant, so this is an
 * overlap test rather than a point-in-time one.
 *
 * `day` is 'YYYY-MM-DD' in IST — the same shape the as-on box and the bid filter use.
 */
function openOnDay(issue, cat, day, settings) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return false;
  if (issue.status === 'Suspended' || issue.status === 'Closed') return false;
  const w = effectiveWin(issue, cat, settings);
  const o = w.open, c = w.close;
  if (isNaN(o) || isNaN(c)) return false;
  const start = new Date(day + 'T00:00:00+05:30');
  const end = new Date(day + 'T23:59:59.999+05:30');
  return o <= end && c >= start;
}

/** Was the issue open on that day, in either category? */
function issueOpenOnDay(issue, day, settings) {
  return openOnDay(issue, 'Retail', day, settings) || openOnDay(issue, 'HNI', day, settings);
}

/** Overall issue status for the dashboard chip. */
function issueStatus(issue, now, settings) {
  const r = catStatus(issue, 'Retail', now, settings), h = catStatus(issue, 'HNI', now, settings);
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
/**
 * The order value. Returns null when a cut-off bid cannot be valued because no floor
 * is published, and never returns a negative — a negative order value is not a small
 * bid, it is a bid that should never have been accepted.
 */
function bidValue(issue, cat, qty, price, isCutoff) {
  const p = isCutoff ? minPrice(issue, cat) : Number(price) || 0;
  if (p == null) return null;
  const v = (Number(qty) || 0) * p;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Full server-side validation. Returns an array of human-readable errors.
 * ctx = { settings, availableMargin, marginUsed, usedValueThisIssue, hasLiveBid, now }
 */
/**
 * Rupees the way the rest of the screen writes them. A validation message is read
 * beside the figures it is talking about, and "200000" next to "₹1,99,800.00" makes
 * the reader do the digit-counting that caused the confusion in the first place.
 */
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const whole = Math.round(n * 100) / 100;
  return '\u20B9' + whole.toLocaleString('en-IN', {
    minimumFractionDigits: whole % 1 ? 2 : 0, maximumFractionDigits: 2
  });
}

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
      /* Only an active client on our own books may bid. The reason matters: a
       * client that is simply not in the client master is a data problem for
       * operations, while a closed account is a client problem, and "not active"
       * alone sends the desk to the wrong person. */
      const why = ctx.client.reason ||
        (ctx.client.status ? 'status is ' + ctx.client.status : null);
      e.push('Client ' + (bid.client_ucc || '') + ' cannot bid' +
        (why ? ' - ' + why : '') + '. Only active clients on our books may bid.');
    }
  }

  /*
   * Which exchange this bid goes to.
   *
   * A bid reaches exactly ONE exchange. Where the issue is listed on one, that is
   * decided; where it is listed on BOTH, somebody must choose, because uploading the
   * NSE file and the BSE file would otherwise submit this client twice.
   */
  const issueExch = String(issue.exchange || '').toUpperCase();
  const bidExch = String(bid.exchange || '').toUpperCase();
  /* Narrowed by where the desk is actually live. With both exchanges enabled this
   * is the same list as before and nothing changes; with one enabled, a BOTH issue
   * has exactly one answer and an issue listed only on the other exchange has none.
   * Checked HERE, not only on the form: the form is a convenience, this is the gate
   * every bid passes through whichever screen it came from. */
  const usable = exchangesFor(issue, s);
  if (!usable.length) {
    e.push(notTradableMessage(issue, s));
  } else if (issueExch === 'BOTH') {
    if (!bidExch) {
      e.push(usable.length === 1
        ? 'This bid must be marked for ' + usable[0] + '.'
        : 'Choose the exchange for this bid — ' + issue.symbol +
          ' is offered on NSE and BSE, and one bid reaches one of them.');
    } else if (usable.indexOf(bidExch) < 0) {
      e.push(bidExch !== 'NSE' && bidExch !== 'BSE'
        ? 'Exchange must be NSE or BSE.'
        : 'Bids are not being accepted on ' + bidExch + ' at present. Please contact the OFS desk.');
    }
  } else if (bidExch && bidExch !== issueExch) {
    e.push(issue.symbol + ' is offered on ' + issueExch + ' only, so a bid cannot go to ' + bidExch + '.');
  }

  const st = catStatus(issue, cat, now, s);
  if (st !== 'Open') e.push(cat + ' bidding for ' + issue.symbol + ' is ' + st.toLowerCase() + '.');

  /* The trading day itself: holidays, trading days, and the desk cut-off.
   *
   * The cut-off lives here AND in catStatus above, deliberately and identically —
   * catStatus applies it to the offer's own close day, this applies it to today.
   * Between them a bid is refused once the desk has stopped, whichever of the two
   * noticed first, and both read the same setting so they cannot disagree. */
  const mkt = marketState(s, now);
  if (!mkt.open) e.push(closedMessage(mkt));

  const lot = Number(issue.lot) || 1;
  const qty = Number(bid.qty);
  // Explicitly finite and positive, not just "not falsy". Infinity and NaN both slip
  // past a bare comparison and produce a bid whose value is meaningless.
  if (!Number.isFinite(qty) || qty <= 0) e.push('Enter a quantity of at least ' + lot + ' share(s).');
  else if (!Number.isInteger(qty)) e.push('Quantity must be a whole number of shares.');
  else if (!isMultiple(qty, lot)) e.push('Quantity must be a multiple of ' + lot + '.');

  const mp = minPrice(issue, cat);
  if (!bid.is_cutoff) {
    const p = Number(bid.price);
    const tick = Number(issue.tick) || 0.05;
    /*
     * A price must be a positive number before anything else is asked of it.
     *
     * This used to be `if (!p)`, which catches zero and blank and lets -5 straight
     * through. On an issue with a published floor the next check caught it by
     * accident; on an issue whose floor is NOT published — which NSE's own FAQ says
     * is normal before the offer opens — there was nothing to compare against, so a
     * negative price passed every check, produced a negative order value, and made
     * the margin test pass trivially.
     */
    if (!Number.isFinite(p) || p === 0) e.push('Enter a bid price.');
    else if (p < 0) e.push('Bid price must be a positive amount.');
    // With no published floor there is nothing to compare against; the exchange
    // applies its own at matching. Rejecting here would refuse every valid bid.
    else if (mp != null && p < mp - 1e-9) {
      e.push('Cannot bid below ' + mp.toFixed(2) + ' for ' + issue.symbol + '.');
    }
    /* The tick check used to round to paise first, so anything within half a paisa
     * of a tick multiple passed — 100.001, 100.004 and 100.049 were all accepted
     * at a 0.05 tick. The row then stored the UNROUNDED price into numeric(18,4),
     * and the exchange file rounded it again to two places, so the exchange
     * received a price the client never entered and a value margin was not blocked
     * against. Compare what will actually be stored. */
    else if (!isMultiple(p, tick)) e.push('Bid price must be in multiples of the ' + tick + ' tick size.');
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
    /* Falling back to the SEBI figure rather than to zero. `|| 0` meant that a
     * blank, a zero or an unparseable hni_min turned the non-retail minimum OFF
     * entirely and silently — an HNI bid of ₹1,000 would be accepted here and
     * rejected at the exchange. A limit we cannot read is a reason to use the
     * regulator's, never a reason to stop checking. */
    const hniMin = Number(s.hni_min) > 0 ? Number(s.hni_min) : 200000;
    if (val < hniMin - 1e-6) {
      const shares = mp != null && mp > 0 ? ' - that is ' + Math.ceil(hniMin / mp) + ' shares at ' + money(mp) : '';
      e.push('An HNI bid must be at least ' + money(hniMin) + shares + '. This one is ' + money(val) + '.');
    }
  } else {
    // Same for the ₹2 lakh retail cap: it is a SEBI limit, not a preference, and a
    // setting nobody can parse must not be able to remove it.
    const cap = Number(s.retail_cap) > 0 ? Number(s.retail_cap) : 200000;
    if (cap) {
      const already = Number(ctx.usedValueThisIssue) || 0;
      const tot = already + val;
      if (tot > cap + 1e-6) {
        /* Where the total came from, not just what it is.
         *
         * "cannot exceed 200000 ... takes it to 381400" over a bid worth 1,99,800
         * reads as a miscalculation: the other 1,81,600 is a DIFFERENT bid, already
         * live on this issue for this client, and the message never said so. Say it,
         * and only frame it as a running total when there actually is one — a single
         * bid over the cap on its own is a simpler fact and deserves the simpler
         * sentence. */
        e.push(already > 0
          ? 'Retail bids in ' + issue.symbol + ' cannot exceed ' + money(cap) + ' in total for one client. '
            + money(already) + ' is already live on this issue, so this bid of ' + money(val)
            + ' would take the total to ' + money(tot) + '.'
          : 'A Retail bid cannot exceed ' + money(cap) + '. This one is ' + money(val) + '.');
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

/**
 * The internal application reference carried by every bid.
 *
 *   OFS-S247683-260913-142509XQ7B
 *   ^   ^        ^      ^     ^
 *   |   |        |      |     four random characters
 *   |   |        |      time of day, IST, to the second
 *   |   |        date, IST, YYMMDD
 *   |   the client's UCC
 *   the module
 *
 * The UCC is IN the reference because of how this number is used: a client reads
 * it out on the phone, a branch quotes it in an email, the desk searches for it in
 * the book. Every one of those starts by establishing whose bid it is, and a
 * reference that already says so removes a step and a class of mistake — the old
 * form, OFS260912-A1B2C, identified the day and nothing else, so two clients'
 * references were indistinguishable until somebody looked them up.
 *
 * Built on IST, not on the server clock. The server runs UTC, so a bid placed at
 * 00:30 IST would otherwise carry YESTERDAY's date in its reference while the bid
 * book, the exchange file and the client's statement all said today.
 *
 * ofs_bid.ref is UNIQUE, and the second component makes a clash essentially
 * impossible: it would take two bids for the SAME client in the SAME second
 * drawing the same four characters, about one chance in 1.6 million. insertBid retries once regardless, because
 * "essentially impossible" is not the same as impossible and the cost of being
 * wrong is a rejected bid during a window.
 */
function makeRef(prefix, ucc) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const part = {};
  for (const x of f.formatToParts(new Date())) part[x.type] = x.value;
  const stamp = part.year + part.month + part.day;
  const clock = part.hour + part.minute + part.second;
  // Anything that is not a letter or a digit would make the reference awkward to
  // read back, to search for, and to put in a CSV.
  const code = String(ucc || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'NOUCC';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
  return [prefix || 'OFS', code, stamp, clock + rand].join('-');
}

/* ------------------------------------------------- the trading day, in IST ---
 *
 * An OFS window runs 09:15 to 15:15 IST. Those two times are the default for
 * every open and every close, and they are here rather than in the form because
 * the form is not the only door: the CSV import and the API come in the same way.
 *
 * There is a second, worse thing this fixes. The form sends a naive local string
 * - "2026-09-16T09:15", no zone - and PostgreSQL reads a naive timestamp in the
 * server's own zone, which is UTC. So 09:15 typed on the desk was stored as 09:15
 * UTC and read back as 14:45 IST: every window was five and a half hours late,
 * which on a one-day offer means the HNI leg opens after lunch and closes at
 * quarter to nine at night. Stamping +05:30 here is what makes the time typed the
 * time meant.
 *
 * A value that already carries a zone is left exactly as it is - an explicit
 * instant is somebody's deliberate answer, not something to round.
 */
const SESSION_OPEN = '09:15';
const SESSION_CLOSE = '15:15';
const IST_OFFSET = '+05:30';

function sessionTime(value, kind) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (!s) return null;

  // Already zoned (…Z or …+05:30): leave it alone.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return s;

  const dflt = kind === 'close' ? SESSION_CLOSE : SESSION_OPEN;

  // Date only.
  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return dateOnly[1] + 'T' + dflt + ':00' + IST_OFFSET;

  // Naive date and time. Midnight is never a real OFS window boundary, so it is
  // read as "the time was left alone" and takes the default.
  const naive = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (naive) {
    const [, date, hh, mm, ss] = naive;
    const midnight = hh === '00' && mm === '00' && (!ss || ss === '00');
    const clock = midnight ? dflt + ':00' : hh + ':' + mm + ':' + (ss || '00');
    return date + 'T' + clock + IST_OFFSET;
  }

  // Not a shape we recognise. Hand it on untouched and let the database judge it.
  return s;
}

module.exports = { CATS, win, effectiveWin, atIstTime, minPrice, floorDisclosed, catStatus,
  issueStatus, isMultiple, istMinutes,
  SESSION_OPEN, SESSION_CLOSE, sessionTime,
  bidExchange, allowedExchanges, exchangeAllowed, exchangesFor, issueTradable, notTradableMessage,
  openOnDay, issueOpenOnDay,
  pastDailyCutoff, marketState, closedMessage, bidValue, validateBid, makeRef };
