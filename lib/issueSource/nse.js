'use strict';
/**
 * NSE issue master.
 *
 * NSE refuses an unprimed request: you must GET a page first to collect cookies,
 * then call the JSON endpoint reusing them. That is handled here, but the endpoint
 * path for OFS is not documented publicly and NSE changes it, so probe() reports
 * what each candidate answered rather than pretending to know.
 *
 * The dependable route remains the member channel: the e-OFS terminal, and the
 * circulars NSE issues per OFS. Treat this as a convenience that may go dark.
 */
const http = require('./http');
const { normalise } = require('./normalise');

const EXCHANGE = 'NSE';
const HOME = 'https://www.nseindia.com';
const PAGE = 'https://www.nseindia.com/market-data/offer-for-sale-ofs';

const CANDIDATES = [
  'https://www.nseindia.com/api/ofs-issues',
  'https://www.nseindia.com/api/offer-for-sale',
  'https://www.nseindia.com/api/liveEquity-ofs'
];

function extractRows(body, contentType) {
  if (!/json/i.test(contentType) && !/^\s*[[{]/.test(body)) return [];
  let data;
  try { data = JSON.parse(body); } catch (e) { return []; }
  const arr = Array.isArray(data) ? data
    : Array.isArray(data.data) ? data.data
    : Array.isArray(data.records) ? data.records
    : Array.isArray(data.rows) ? data.rows
    : null;
  return Array.isArray(arr) ? arr.filter((r) => r && typeof r === 'object') : [];
}

async function probe() {
  const jar = http.makeJar();
  // Prime cookies; without this every API call comes back 401 or an HTML shell.
  const home = await http.get(HOME, { jar });
  const attempts = [{ url: HOME, status: home.status, ok: home.ok,
                      cookies: jar.size(), note: 'cookie priming' }];

  for (const url of CANDIDATES) {
    const res = await http.get(url, { referer: PAGE, jar });
    const rows = res.ok ? extractRows(res.body, res.contentType) : [];
    attempts.push({
      url, status: res.status, ok: res.ok,
      contentType: res.contentType.split(';')[0],
      bytes: res.body ? res.body.length : 0,
      rows: rows.length,
      error: res.error || null,
      sampleKeys: rows.length ? Object.keys(rows[0]).slice(0, 25) : [],
      sample: rows.length ? rows[0] : null,
      bodyHead: !rows.length && res.body ? res.body.slice(0, 400) : null
    });
    if (rows.length) break;
  }
  return attempts;
}

async function fetchIssues() {
  const attempts = await probe();
  const hit = attempts.find((a) => a.rows > 0);
  if (!hit) return { issues: [], rejected: [], source: null, attempts };

  const jar = http.makeJar();
  await http.get(HOME, { jar });
  const res = await http.get(hit.url, { referer: PAGE, jar });
  const rows = extractRows(res.body, res.contentType);

  const issues = [], rejected = [];
  for (const r of rows) {
    const n = normalise(r, EXCHANGE);
    if (n.ok) issues.push(n.issue); else rejected.push({ reason: n.reason, raw: n.raw });
  }
  return { issues, rejected, source: hit.url, attempts };
}

module.exports = { EXCHANGE, HOME, PAGE, CANDIDATES, extractRows, probe, fetchIssues };
