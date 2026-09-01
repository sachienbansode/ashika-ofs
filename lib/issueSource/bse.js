'use strict';
/**
 * BSE issue master.
 *
 * Public listing: Markets → Offer for Sale → Live/Forthcoming
 *   https://www.bseindia.com/markets/publicissues/OFSIssuse_new.aspx
 * BSE also serves the same data as JSON to its own front end. The exact path moves,
 * so candidates are tried in order and the first that returns usable rows wins —
 * and `probe()` reports what each one actually answered, which is how a broken
 * endpoint gets diagnosed in one run rather than by guesswork.
 */
const http = require('./http');
const { normalise } = require('./normalise');

const EXCHANGE = 'BSE';
const PAGE = 'https://www.bseindia.com/markets/publicissues/OFSIssuse_new.aspx';

const CANDIDATES = [
  'https://api.bseindia.com/BseIndiaAPI/api/GetOFSIssueData/w?Type=L',
  'https://api.bseindia.com/BseIndiaAPI/api/OFSIssue/w?Type=L',
  PAGE
];

/** Rows out of JSON of almost any shape, or out of an HTML table. */
function extractRows(body, contentType) {
  const looksJson = /json/i.test(contentType) || /^\s*[[{]/.test(body);
  if (looksJson) {
    let data;
    try { data = JSON.parse(body); } catch (e) { return []; }
    // BSE wraps payloads inconsistently: an array, or {Table:[...]}, or {Data:[...]}
    const arr = Array.isArray(data) ? data
      : Array.isArray(data.Table) ? data.Table
      : Array.isArray(data.Data) ? data.Data
      : Array.isArray(data.data) ? data.data
      : Array.isArray(data.result) ? data.result
      : null;
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r === 'object') : [];
  }
  return htmlTableRows(body);
}

/** Last resort: the rendered table. Fragile by nature, so it is the final candidate. */
function htmlTableRows(html) {
  const out = [];
  const tables = String(html).match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    const trs = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (trs.length < 2) continue;
    const cells = (tr) => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    const head = cells(trs[0]);
    if (!head.some((h) => /symbol|scrip|company|security/i.test(h))) continue;
    if (!head.some((h) => /floor|price/i.test(h))) continue;
    for (const tr of trs.slice(1)) {
      const c = cells(tr);
      if (c.length !== head.length) continue;
      const row = {};
      head.forEach((h, i) => { if (h) row[h] = c[i]; });
      if (Object.keys(row).length) out.push(row);
    }
  }
  return out;
}

/** Try each candidate; report what every one of them said. No writes. */
async function probe() {
  const attempts = [];
  for (const url of CANDIDATES) {
    const res = await http.get(url, { referer: PAGE });
    const rows = res.ok ? extractRows(res.body, res.contentType) : [];
    attempts.push({
      url,
      status: res.status,
      ok: res.ok,
      contentType: res.contentType.split(';')[0],
      bytes: res.body ? res.body.length : 0,
      rows: rows.length,
      error: res.error || null,
      sampleKeys: rows.length ? Object.keys(rows[0]).slice(0, 25) : [],
      sample: rows.length ? rows[0] : null,
      bodyHead: !rows.length && res.body ? res.body.slice(0, 400) : null
    });
    if (rows.length) break;                  // first usable endpoint wins
  }
  return attempts;
}

/** @returns {{issues:[], rejected:[], source:string|null, attempts:[]}} */
async function fetchIssues() {
  const attempts = await probe();
  const hit = attempts.find((a) => a.rows > 0);
  if (!hit) return { issues: [], rejected: [], source: null, attempts };

  const res = await http.get(hit.url, { referer: PAGE });
  const rows = extractRows(res.body, res.contentType);

  const issues = [], rejected = [];
  for (const r of rows) {
    const n = normalise(r, EXCHANGE);
    if (n.ok) issues.push(n.issue); else rejected.push({ reason: n.reason, raw: n.raw });
  }
  return { issues, rejected, source: hit.url, attempts };
}

module.exports = { EXCHANGE, PAGE, CANDIDATES, extractRows, htmlTableRows, probe, fetchIssues };
