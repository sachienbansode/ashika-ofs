'use strict';
/**
 * Turn whatever an exchange gives us into an ofs_issue row.
 *
 * Everything here is defensive on purpose: field names differ between the two
 * exchanges and change without notice, so a source hands over loose key/value data
 * and this decides what is usable. An issue missing a symbol, a floor price or a
 * window is REJECTED with a reason rather than written half-formed — a half-formed
 * issue produces a bad exchange file, which is discovered far too late.
 */
/**
 * Currency symbols, commas and stray spaces are stripped. A value with NO digit at
 * all returns null rather than 0 — 'n/a' becoming zero would silently overwrite a
 * real quantity, or turn into a zero floor price.
 */
const num = (v) => {
  if (v == null) return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find a value by any of several likely field names, ignoring case, spaces and
 * punctuation. Exact matches are preferred across ALL the candidate names before
 * any prefix match is considered, so 'ISIN' wins over 'ISIN No' when both exist,
 * while a source that only offers 'ISIN No' still resolves.
 */
const pick = (o, ...keys) => {
  const actual = Object.keys(o || {});
  const value = (k) => {
    const v = o[k];
    return v != null && String(v).trim() !== '' ? String(v).trim() : null;
  };

  for (const k of keys) {
    const want = flat(k);
    for (const a of actual) if (flat(a) === want) { const v = value(a); if (v) return v; }
  }
  for (const k of keys) {
    const want = flat(k);
    for (const a of actual) if (flat(a).startsWith(want)) { const v = value(a); if (v) return v; }
  }
  return null;
};

/** Parse the many date shapes exchanges use, in IST. */
function toDate(dateStr, timeStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  let y, m, d;

  let mm = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                     // 2026-09-02
  if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }

  if (!y) {
    mm = s.match(/^(\d{1,2})[-\/ ](\d{1,2})[-\/ ](\d{4})/);         // 02-09-2026 (dd-mm-yyyy)
    if (mm) { d = +mm[1]; m = +mm[2]; y = +mm[3]; }
  }
  if (!y) {
    const MON = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    mm = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})/); // 02-Sep-2026
    if (mm && MON[mm[2].toLowerCase()]) { d = +mm[1]; m = MON[mm[2].toLowerCase()]; y = +mm[3]; }
  }
  if (!y || !m || !d) return null;

  const t = String(timeStr || '09:15').match(/(\d{1,2}):(\d{2})/);
  const hh = t ? +t[1] : 9, mi = t ? +t[2] : 15;

  const p = (x) => String(x).padStart(2, '0');
  // +05:30 explicitly: exchange times are IST and the server runs UTC.
  return `${y}-${p(m)}-${p(d)}T${p(hh)}:${p(mi)}:00+05:30`;
}

/**
 * @returns {{ok:true, issue:object} | {ok:false, reason:string, raw:object}}
 */
function normalise(raw, exchange) {
  const symbol = pick(raw, 'symbol', 'scripname', 'securityname', 'scripid', 'ofssymbol');
  const company = pick(raw, 'company', 'companyname', 'issuername', 'scripname', 'securityname');
  const isin = pick(raw, 'isin', 'isinno', 'isincode');
  const floor = num(pick(raw, 'floorprice', 'floor', 'price'));

  if (!symbol) return { ok: false, reason: 'no symbol', raw };
  if (!floor || floor <= 0) return { ok: false, reason: 'no floor price', raw };

  // Non-retail runs on T, retail on T+1. Sources name these many ways.
  const niDate = pick(raw, 'nonretaildate', 'biddate', 'issuedate', 'startdate', 'ofsdate', 'tdate');
  const riDate = pick(raw, 'retaildate', 'retailbiddate', 'enddate', 't1date');
  const openT = pick(raw, 'starttime', 'bidstarttime', 'opentime') || '09:15';
  const closeT = pick(raw, 'endtime', 'bidendtime', 'closetime') || '15:30';

  const hniOpen = toDate(niDate, openT);
  const hniClose = toDate(niDate, closeT);
  const retOpen = toDate(riDate || niDate, openT);
  const retClose = toDate(riDate || niDate, closeT);

  if (!hniOpen || !hniClose) return { ok: false, reason: 'no usable non-retail date', raw };
  if (!retOpen || !retClose) return { ok: false, reason: 'no usable retail date', raw };

  const issue = {
    symbol: symbol.toUpperCase().slice(0, 20),
    company: company || symbol,
    isin: (isin || '').toUpperCase() || null,
    exchange: exchange,
    bse_scrip_code: exchange === 'BSE' ? pick(raw, 'scripcode', 'scripcd', 'securitycode') : null,
    floor_price: floor,
    cut_price_min: num(pick(raw, 'cutoffprice', 'cutprice', 'retailcutoff')) || floor,
    tick: num(pick(raw, 'tick', 'ticksize')) || 0.05,
    lot: num(pick(raw, 'lot', 'marketlot', 'lotsize')) || 1,
    issue_qty: num(pick(raw, 'offerquantity', 'totalquantity', 'quantity', 'sharesoffered')),
    retail_qty: num(pick(raw, 'retailquantity', 'retailreservation')),
    discount_pct: num(pick(raw, 'discount', 'retaildiscount', 'discountpercent')) || 0,
    hni_open: hniOpen, hni_close: hniClose, ret_open: retOpen, ret_close: retClose,
    source: 'exchange'
  };

  if (!issue.isin) return { ok: false, reason: 'no ISIN', raw, partial: issue };
  return { ok: true, issue };
}

module.exports = { normalise, toDate, num, pick };
