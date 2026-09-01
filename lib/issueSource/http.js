'use strict';
/**
 * Fetching from exchange sites.
 *
 * Both exchanges refuse plain programmatic requests: BSE answers 403 without
 * browser-like headers, and NSE additionally requires cookies obtained by visiting
 * a page first. Neither is a paywall — the data is public — so the polite approach
 * is a real User-Agent, a matching Referer, a cookie jar, and low request volume.
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

async function get(url, { referer, jar, timeoutMs = 15000 } = {}) {
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

module.exports = { get, makeJar, baseHeaders, DEFAULT_UA };
