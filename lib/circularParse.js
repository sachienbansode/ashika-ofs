'use strict';
/**
 * Reading an OFS circular PDF for the numbers the desk would otherwise retype.
 *
 * Everything here is BEST EFFORT and clearly labelled as such. NSE's circulars are
 * prose with an embedded table; the wording moves between issues, and a wrong floor
 * price is far worse than a blank one. So each field is returned with the snippet it
 * came from, nothing is guessed from a partial match, and an issue built from this
 * is never biddable until a person has checked it against the PDF.
 *
 * No database, no network — give it text, get fields back.
 */

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11 };

/** Normalise the whitespace PDFs love to scatter. */
function flatten(text) {
  return String(text || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** "12,34,567.89" (Indian grouping) or "1234567.89" -> Number. */
function num(v) {
  const s = String(v == null ? '' : v).replace(/[,\s₹]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

/** "September 2, 2026", "02-Sep-2026", "02/09/2026", "2 September 2026" -> Date (IST midnight). */
function parseDate(raw) {
  const s = String(raw || '').trim();
  let m = /(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{4})/.exec(s);
  if (m && MONTHS[m[2].slice(0, 4).toLowerCase()] !== undefined) {
    return mk(Number(m[3]), MONTHS[m[2].slice(0, 4).toLowerCase()], Number(m[1]));
  }
  m = /([A-Za-z]{3,9})[\s.]+(\d{1,2})[\s,]+(\d{4})/.exec(s);
  if (m && MONTHS[m[1].slice(0, 4).toLowerCase()] !== undefined) {
    return mk(Number(m[3]), MONTHS[m[1].slice(0, 4).toLowerCase()], Number(m[2]));
  }
  m = /(\d{1,2})[\-/](\d{1,2})[\-/](\d{4})/.exec(s);           // dd/mm/yyyy — Indian order
  if (m) return mk(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

/** A calendar date at 00:00 IST, expressed as the correct UTC instant. */
function mk(y, mo, d) {
  if (!(y > 2000 && mo >= 0 && mo <= 11 && d >= 1 && d <= 31)) return null;
  return new Date(Date.UTC(y, mo, d, 0, 0, 0) - 5.5 * 3600 * 1000);
}

/** Pull the first capture of the first pattern that matches, with its context. */
function find(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) {
      const at = Math.max(0, m.index - 40);
      return { value: m[1].trim(), snippet: text.slice(at, m.index + m[0].length + 40).replace(/\n/g, ' ') };
    }
  }
  return null;
}

/** The three date shapes NSE circulars actually use. */
const DATE = '(?:[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})'
           + '|(?:\\d{1,2}[\\s\\-/.]{1,2}[A-Za-z]{3,9}[\\s\\-/.,]{1,2}\\d{4})'
           + '|(?:\\d{1,2}[\\-/]\\d{1,2}[\\-/]\\d{4})';

const RE = {
  symbol: [
    /\bsymbol\s*[:\-–]?\s*([A-Z][A-Z0-9&\-]{1,19})\b/i,
    /\bscrip\s*(?:code|symbol)\s*[:\-–]?\s*([A-Z][A-Z0-9&\-]{1,19})\b/i
  ],
  isin: [/\b(IN[A-Z0-9]{9}\d)\b/],
  floor: [
    /floor\s*price[^0-9₹]{0,40}₹?\s*([0-9][0-9,]*\.?\d*)/i,
    /price[^0-9₹]{0,20}(?:of|at)\s*₹\s*([0-9][0-9,]*\.?\d*)\s*(?:per\s*(?:equity\s*)?share)/i
  ],
  qty: [
    /(?:offer|sale)\s*(?:size|quantity)[^0-9]{0,40}([0-9][0-9,]{3,})/i,
    /up\s*to\s*([0-9][0-9,]{4,})\s*(?:equity\s*)?shares/i
  ],
  // Match a DATE SHAPE rather than "on <something>". The lazy version stopped at the
  // comma in "May 27, 2026" and handed parseDate a year-less "May 27".
  nonRetailDate: [
    new RegExp('non[\\s-]*retail[^.\\n]{0,120}?(' + DATE + ')', 'i'),
    new RegExp('T\\s*day[^.\\n]{0,60}?(' + DATE + ')', 'i')
  ],
  retailDate: [
    // The negative lookbehind is the whole trick: without it, \bretail matches the
    // "Retail" inside "Non-Retail", both dates come out identical, and the
    // ordering check below then throws away a perfectly good pair.
    new RegExp('(?<!non[\\s-])\\bretail[^.\\n]{0,120}?(' + DATE + ')', 'i'),
    new RegExp('T\\s*\\+\\s*1[^.\\n]{0,60}?(' + DATE + ')', 'i')
  ]
};

/**
 * Extract what can be read with confidence.
 * Returns { fields, found, missing } where each field carries { value, snippet }.
 */
function extract(rawText) {
  const text = flatten(rawText);
  const out = {};

  const sym = find(text, RE.symbol);
  if (sym) out.symbol = { value: sym.value.toUpperCase(), snippet: sym.snippet };

  const isin = find(text, RE.isin);
  if (isin) out.isin = { value: isin.value.toUpperCase(), snippet: isin.snippet };

  const floor = find(text, RE.floor);
  if (floor && num(floor.value) > 0) out.floor_price = { value: num(floor.value), snippet: floor.snippet };

  const qty = find(text, RE.qty);
  if (qty && num(qty.value) > 0) out.issue_qty = { value: num(qty.value), snippet: qty.snippet };

  const nr = find(text, RE.nonRetailDate);
  const nrDate = nr && parseDate(nr.value);
  if (nrDate) out.hni_date = { value: nrDate.toISOString(), snippet: nr.snippet };

  const r = find(text, RE.retailDate);
  const rDate = r && parseDate(r.value);
  if (rDate) out.ret_date = { value: rDate.toISOString(), snippet: r.snippet };

  // Retail must follow non-retail. If the two came out the wrong way round, we read
  // them wrong — drop both rather than write a window nobody can trust.
  if (out.hni_date && out.ret_date && new Date(out.ret_date.value) <= new Date(out.hni_date.value)) {
    delete out.hni_date;
    delete out.ret_date;
    out._date_conflict = { value: true, snippet: 'retail date was not after the non-retail date' };
  }

  const WANT = ['symbol', 'isin', 'floor_price', 'issue_qty', 'hni_date', 'ret_date'];
  return {
    fields: out,
    found: WANT.filter((k) => out[k]),
    missing: WANT.filter((k) => !out[k])
  };
}

module.exports = { extract, parseDate, num, flatten, RE };
