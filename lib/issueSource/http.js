'use strict';
/**
 * Fetching from exchange websites.
 *
 * ⚠ READ BEFORE ENABLING. Both exchanges' terms of use expressly prohibit this:
 *
 *   NSE: "systematic or automated data collection activities (including scraping,
 *   data mining, data extraction and data harvesting)" are prohibited, and content
 *   may not be copied or distributed "without prior written permission of NSE".
 *   BSE: "You should not conduct any systematic or automated data collection
 *   activities ... without our express written consent" (clause 13), and the site
 *   "may be used only for lawful and permitted purposes ... for non-commercial
 *   purposes only" (clause 23).
 *
 * Ashika is a SEBI-registered trading member. Breaching an exchange's website terms
 * is a needless compliance exposure when the same data arrives through member
 * entitlements — the e-OFS and iBBS terminals, the member extranet, and the T-2/T-1
 * notices already sent to members.
 *
 * So this is OFF by default and must be turned on deliberately, ideally only once
 * written consent exists. The sanctioned route is Masters → Import issues CSV, fed
 * from the member notice.
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

function baseHeaders(referer) {
  return {
    'User-Agent': process.env.EXCHANGE_FETCH_UA || DEFAULT_UA,
    'Accept': 'application/json, text/html, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer || '',
    'Cache-Control': 'no-cache'
  };
}

/** Minimal cookie jar — enough for NSE's "visit the site first" requirement. */
function makeJar() {
  const jar = new Map();
  return {
    absorb(res) {
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const [pair] = String(c).split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ');
    },
    size() { return jar.size; }
  };
}

/** Web fetching is opt-in; see the note above. */
function enabled() {
  return String(process.env.EXCHANGE_WEB_FETCH || '') === 'true';
}

async function get(url, { referer, jar, timeoutMs = 15000 } = {}) {
  if (!enabled()) {
    return {
      ok: false, status: 0, contentType: '', body: '', url,
      error: 'EXCHANGE_WEB_FETCH is not enabled. Both exchanges prohibit automated ' +
             'collection without written consent — use Masters → Import issues CSV, ' +
             'fed from the member notice, or obtain consent first.'
    };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = baseHeaders(referer);
    if (jar && jar.size()) headers.Cookie = jar.header();
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
    if (jar) jar.absorb(res);
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body,
      url
    };
  } catch (e) {
    return { ok: false, status: 0, contentType: '', body: '', url, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { get, makeJar, baseHeaders, enabled, DEFAULT_UA };
