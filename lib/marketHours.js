'use strict';
/**
 * When may a bid be placed?
 *
 * Three gates, narrowest wins:
 *   1. the exchange's own OFS window for the category (lib/domain.js catStatus)
 *   2. the trading session — weekday, not a holiday, between market open and close
 *   3. the desk's daily cut-off, which OVERRIDES the session end
 *
 * The cut-off overriding the end is the point: a desk that stops taking bids at
 * 15:15 must stop at 15:15 even though the market runs to 15:30, and if it is ever
 * set later than the close, the cut-off is what applies. Everything is compared in
 * Asia/Kolkata explicitly — the app server runs UTC, so the host's clock is never
 * consulted for a trading decision.
 *
 * No database and no settings import here, so every rule below is unit-testable.
 */

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
});

const DAY_NO = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** { date:'2026-09-01', dow:2, minutes:565, hhmm:'09:25' } in IST. */
function istNow(now) {
  const p = {};
  for (const part of PARTS.formatToParts(now || new Date())) p[part.type] = part.value;
  const h = Number(p.hour) % 24;              // en-GB gives '24' for midnight
  const m = Number(p.minute);
  return {
    date: p.year + '-' + p.month + '-' + p.day,
    dow: DAY_NO[p.weekday] != null ? DAY_NO[p.weekday] : -1,
    minutes: h * 60 + m,
    hhmm: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
  };
}

/** 'HH:MM' -> minutes past midnight, or null when blank/unparseable. */
function toMinutes(hhmm) {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const fmt = (mins) => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');

/** '1-5' or '1,2,3,4,5' or 'Mon-Fri' -> Set of day numbers. Defaults to Mon–Fri. */
function tradingDays(spec) {
  const raw = String(spec == null ? '1-5' : spec).trim();
  if (!raw) return new Set([1, 2, 3, 4, 5]);
  const out = new Set();
  for (const part of raw.split(',')) {
    const range = /^(\d)\s*-\s*(\d)$/.exec(part.trim());
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) out.add(d);
    } else if (/^\d$/.test(part.trim())) {
      out.add(Number(part.trim()));
    }
  }
  return out.size ? out : new Set([1, 2, 3, 4, 5]);
}

/** 'YYYY-MM-DD, YYYY-MM-DD' -> Set. Anything not in that shape is ignored, not guessed. */
function holidaySet(spec) {
  const out = new Set();
  for (const d of String(spec || '').split(/[,\s;]+/)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d);
  }
  return out;
}

/**
 * The trading-session verdict for `now`.
 * Returns { open, reason, ist, opens, closes, effectiveClose, cutoffApplies, minutesLeft }.
 * `reason` is null when open, otherwise one of holiday | weekend | before_open | after_cutoff | after_close.
 */
function marketState(settings, now) {
  const s = settings || {};
  const ist = istNow(now);

  const open = toMinutes(s.market_open) != null ? toMinutes(s.market_open) : 9 * 60 + 15;
  const close = toMinutes(s.market_close) != null ? toMinutes(s.market_close) : 15 * 60 + 30;
  const cutoff = toMinutes(s.daily_cutoff);              // null = no desk cut-off set

  // The cut-off wins outright — earlier OR later than the session end.
  const effective = cutoff != null ? cutoff : close;

  const base = {
    ist,
    opens: fmt(open),
    closes: fmt(close),
    effectiveClose: fmt(effective),
    cutoffApplies: cutoff != null && cutoff !== close,
    minutesLeft: 0
  };

  if (holidaySet(s.trading_holidays).has(ist.date)) {
    return Object.assign(base, { open: false, reason: 'holiday' });
  }
  if (!tradingDays(s.market_days).has(ist.dow)) {
    return Object.assign(base, { open: false, reason: 'weekend' });
  }
  if (ist.minutes < open) return Object.assign(base, { open: false, reason: 'before_open' });
  if (ist.minutes >= effective) {
    return Object.assign(base, {
      open: false,
      reason: cutoff != null && cutoff <= close ? 'after_cutoff' : 'after_close'
    });
  }
  return Object.assign(base, { open: true, reason: null, minutesLeft: effective - ist.minutes });
}

/** One sentence for the desk, the client app and the bid rejection alike. */
function closedMessage(st) {
  switch (st.reason) {
    case 'holiday':     return 'The market is closed today (trading holiday). Bids reopen on the next trading day at ' + st.opens + ' IST.';
    case 'weekend':     return 'The market is closed today. Bids reopen on the next trading day at ' + st.opens + ' IST.';
    case 'before_open': return 'Bidding opens at ' + st.opens + ' IST.';
    case 'after_cutoff':return 'The desk cut-off of ' + st.effectiveClose + ' IST has passed. No further bids are accepted today.';
    case 'after_close': return 'The market closed at ' + st.effectiveClose + ' IST. No further bids are accepted today.';
    default:            return 'Bidding is closed.';
  }
}

module.exports = { istNow, toMinutes, tradingDays, holidaySet, marketState, closedMessage };
