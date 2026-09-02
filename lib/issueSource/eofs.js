'use strict';
/**
 * NSE e-OFS Web API — the issue master, properly.
 *
 * `GET /query/activeSecurities` returns everything the desk retypes: ISIN, tick,
 * lot, floor price, offer size and both windows. This is the sanctioned automated
 * fetch, as opposed to lib/issueSource/nse.js, which scrapes pages NSE's terms
 * forbid and which do not answer anyway.
 *
 * From "NSE Offer for Sale System WEB API Protocol" v1.3.0 (Feb 2024):
 *   POST /auth/token          -> { token } used as `Authorization: Bearer <token>`
 *   POST /auth/refreshToken   -> extends it
 *   GET  /query/activeSecurities
 *        symbol, securityName, isinCode, faceValue, tickSize, regularLotSize,
 *        configurations[]: symbol, series, issueSize, basePrice, openOnDate,
 *        mktOpenTime, mktCloseTime, mktModCxlOpenTime, mktModCxlCloseTime,
 *        isNewOrderAllowed, isModificationAllowed, isCancellationAllowed, ...
 *
 * DORMANT UNTIL CREDENTIALS EXIST. configured() is false without them, so nothing
 * here runs, nothing fails, and the day NSE enables the member it starts working
 * with no code change — only .env.
 *
 * Two mappings are inferences, and both are settings rather than assumptions baked
 * in, because v1.3.0 does not state them:
 *   - `basePrice` is taken to be the floor price;
 *   - series IS is the Non-Retail window and RS the Retail one.
 * Confirm both with NSE (docs/NSE_API_REQUEST.md asks).
 */
const { num } = require('./normalise');

const EXCHANGE = 'NSE';

const BASE = () => String(process.env.OFS_EOFS_BASE || 'https://eofs.nseindia.com/api').replace(/\/+$/, '');
const USER = () => process.env.OFS_EOFS_USER || '';
const PASS = () => process.env.OFS_EOFS_PASS || '';
const TIMEOUT = Number(process.env.OFS_EOFS_TIMEOUT_MS || 20000);

/** Nothing here runs without credentials. */
function configured() {
  return Boolean(USER() && PASS());
}

/* ------------------------------------------------------------------ session --
 * One token, reused until it is nearly expired. The protocol states ONE CONCURRENT
 * LOGIN PER API USER, so authenticating per request would fight itself. */
let session = { token: null, until: 0 };

async function req(path, opts) {
  const o = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(BASE() + path, {
      method: o.method || 'GET',
      headers: Object.assign(
        { Accept: 'application/json' },
        o.body ? { 'Content-Type': 'application/json' } : {},
        o.token ? { Authorization: 'Bearer ' + o.token } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* reported below */ }
    return { ok: res.ok, status: res.status, json, text, url: BASE() + path };
  } catch (e) {
    const code = (e.cause && e.cause.code) || e.code || e.name;
    return { ok: false, status: 0, json: null, text: '', url: BASE() + path,
             error: code === 'AbortError' ? 'no reply within ' + TIMEOUT + 'ms' : (code || e.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function token(force) {
  if (!force && session.token && Date.now() < session.until) return session.token;
  const r = await req('/auth/token', { method: 'POST', body: { userId: USER(), password: PASS() } });
  if (!r.ok) {
    const e = new Error('e-OFS sign-in failed: ' + (r.error || ('HTTP ' + r.status)));
    e.status = r.status;
    throw e;
  }
  const t = r.json && (r.json.token || r.json.accessToken || (r.json.data && r.json.data.token));
  if (!t) throw new Error('e-OFS sign-in returned no token — the response shape has changed.');
  // Refresh well before the hour the protocol allows, so a long poll never races it.
  session = { token: t, until: Date.now() + 45 * 60 * 1000 };
  return t;
}

/* ---------------------------------------------------------------- mapping -- */

/** "09:15:00" / "0915" / "9:15" -> minutes past midnight, or null. */
function timeToMinutes(v) {
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{2})(\d{2})$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}

/** A calendar date plus minutes-in-IST, as the correct UTC instant. */
function istAt(dateLike, minutes) {
  const d = String(dateLike || '').trim();
  let y, mo, day;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (m) { y = +m[1]; mo = +m[2] - 1; day = +m[3]; }
  else {
    m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(d);          // dd-mm-yyyy, Indian order
    if (m) { y = +m[3]; mo = +m[2] - 1; day = +m[1]; }
    else {
      const parsed = new Date(d);
      if (isNaN(parsed)) return null;
      y = parsed.getUTCFullYear(); mo = parsed.getUTCMonth(); day = parsed.getUTCDate();
    }
  }
  if (minutes == null) return null;
  return new Date(Date.UTC(y, mo, day, 0, 0, 0) + minutes * 60000 - 5.5 * 3600 * 1000);
}

/** Which of our two windows a series belongs to. A setting, because v1.3.0 is silent. */
function windowFor(series, settings) {
  const s = settings || {};
  const hni = (s.nse_series_hni || 'IS').toUpperCase();
  const ret = (s.nse_series_retail || 'RS').toUpperCase();
  const code = String(series || '').toUpperCase();
  if (code === hni) return 'hni';
  if (code === ret) return 'ret';
  return null;                                     // ES, or something new — not guessed
}

/**
 * One security plus its per-series configurations -> one of our issues.
 * Returns { issue } or { rejected: reason } — never a half-built row.
 */
function toIssue(sec, settings) {
  const symbol = String(sec.symbol || '').trim().toUpperCase();
  const isin = String(sec.isinCode || sec.isin || '').trim().toUpperCase();
  if (!symbol) return { rejected: 'no symbol' };

  const cfgs = Array.isArray(sec.configurations) ? sec.configurations : [];
  if (!cfgs.length) return { rejected: symbol + ': no series configuration' };

  const win = {};
  let floor = null, qty = null;
  const unmapped = [];

  for (const c of cfgs) {
    const which = windowFor(c.series, settings);
    if (!which) { unmapped.push(String(c.series || '?')); continue; }
    const open = istAt(c.openOnDate, timeToMinutes(c.mktOpenTime));
    const close = istAt(c.openOnDate, timeToMinutes(c.mktCloseTime));
    if (!open || !close || close <= open) continue;
    win[which] = { open: open, close: close };
    if (floor == null && num(c.basePrice) > 0) floor = num(c.basePrice);
    if (qty == null && num(c.issueSize) > 0) qty = num(c.issueSize);
  }

  if (!win.hni && !win.ret) {
    return { rejected: symbol + ': no usable window' +
      (unmapped.length ? ' (unmapped series: ' + unmapped.join(', ') + ')' : '') };
  }
  // A single-series OFS is legitimate; mirror the one we have rather than invent one.
  const hni = win.hni || win.ret;
  const ret = win.ret || win.hni;
  if (!floor) return { rejected: symbol + ': no basePrice' };

  return {
    issue: {
      symbol: symbol,
      company: String(sec.securityName || sec.companyName || symbol).trim(),
      isin: isin || 'ISIN-UNKNOWN',
      exchange: EXCHANGE,
      floor_price: floor,
      cut_price_min: floor,
      tick: num(sec.tickSize) || 0.05,
      lot: num(sec.regularLotSize) || 1,
      issue_qty: qty,
      hni_open: hni.open, hni_close: hni.close,
      ret_open: ret.open, ret_close: ret.close,
      source: 'eofs'
    },
    warnings: unmapped.length ? [symbol + ': ignored series ' + unmapped.join(', ')] : []
  };
}

/* ------------------------------------------------------------------ fetch -- */

/** Same shape as the other sources: { source, issues, rejected, attempts }. */
async function fetchIssues(settings) {
  const attempts = [];
  if (!configured()) {
    return { source: null, issues: [], rejected: [], attempts: [{
      url: BASE() + '/query/activeSecurities', status: 0, ok: false, rows: 0,
      error: 'e-OFS credentials are not configured (OFS_EOFS_USER / OFS_EOFS_PASS). '
           + 'Ask NSE for API enablement — see docs/NSE_API_REQUEST.md.' }] };
  }

  let t;
  try {
    t = await token();
    attempts.push({ url: BASE() + '/auth/token', status: 200, ok: true, rows: 0, note: 'signed in' });
  } catch (e) {
    return { source: null, issues: [], rejected: [], attempts: [
      { url: BASE() + '/auth/token', status: e.status || 0, ok: false, rows: 0, error: e.message }] };
  }

  let r = await req('/query/activeSecurities', { token: t });
  if (r.status === 401) {                       // token rejected — sign in once more
    t = await token(true);
    r = await req('/query/activeSecurities', { token: t });
  }

  const list = !r.json ? []
    : Array.isArray(r.json) ? r.json
    : Array.isArray(r.json.data) ? r.json.data
    : Array.isArray(r.json.securities) ? r.json.securities
    : [];

  attempts.push({ url: r.url, status: r.status, ok: r.ok, rows: list.length, error: r.error });

  if (!r.ok) return { source: null, issues: [], rejected: [], attempts };

  const issues = [], rejected = [];
  for (const sec of list) {
    const out = toIssue(sec, settings);
    if (out.issue) issues.push(out.issue); else rejected.push(out.rejected);
  }

  return { source: issues.length ? 'e-OFS Web API' : null, issues, rejected, attempts };
}

module.exports = { EXCHANGE, configured, fetchIssues, toIssue, timeToMinutes, istAt, windowFor, token };
