'use strict';
/**
 * NSE circulars RSS — parsing and matching, with no database and no network, so the
 * part that decides "is this an OFS announcement?" is testable on its own.
 *
 * Why this is allowed where scraping is not: RSS is published in order to be polled.
 * NSE offers the feed, and an email subscription to the same circulars, precisely so
 * members can consume them mechanically. Nothing here reads a page that was meant
 * for a browser, and nothing here is behind a login.
 *
 * Feed: https://nsearchives.nseindia.com/content/RSS/Circulars.xml
 * Verified against the live feed on 2 Sep 2026: each <item> carries <title>, <link>
 * (a direct PDF/ZIP), <description> and <pubDate>. There is NO <department> element —
 * the department is encoded in the LINK FILENAME (CML76118.pdf -> CML), which is why
 * departmentOf() reads the link.
 *
 * The feed is a rolling window of recent circulars, not an archive. If the poller is
 * down for a day it can miss one, so the desk should also subscribe to NSE's circular
 * emails as a backstop — see docs/EXCHANGE_APIS.md.
 */

const FEED_URL = process.env.NSE_CIRCULAR_FEED
  || 'https://nsearchives.nseindia.com/content/RSS/Circulars.xml';

/** CMTR is the trading department, which is where OFS circulars are issued. */
const OFS_DEPARTMENTS = ['CMTR', 'CMPT'];

/**
 * The title NSE uses is "Proposed Offer for Sale by <Company>", but circulars for
 * the same issue also appear as "Offer for Sale - <Company>" and with the OFS
 * abbreviation, so match on the phrase rather than the exact sentence.
 */
const OFS_TITLE_RE = /\b(offer\s+for\s+sale|\bOFS\b)/i;

function unescapeXml(v) {
  return String(v || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')            // last, so &amp;lt; does not double-decode
    .trim();
}

function tag(block, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
  return m ? unescapeXml(m[1]) : null;
}

/** The department is in the filename, e.g. .../CMTR72975.zip -> CMTR. */
function departmentOf(link) {
  const file = String(link || '').split('/').pop() || '';
  const m = /([A-Z]{2,6})[_-]?\d{3,}/.exec(file.toUpperCase());
  return m ? m[1] : null;
}

/** "Proposed Offer for Sale by Coal India Limited" -> "Coal India Limited". */
function companyOf(title) {
  const t = String(title || '');
  let m = /offer\s+for\s+sale\s+(?:of\s+shares\s+)?(?:by|of|in|for|-|–|—|:)\s+(.+?)\s*$/i.exec(t);
  if (!m) m = /^(.+?)\s*[-–—:]\s*offer\s+for\s+sale/i.exec(t);
  if (!m) return null;
  return m[1]
    .replace(/\s*[-–—(].*$/, '')       // drop trailing "- revised", "(OFS)" etc.
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function parseDate(v) {
  const d = new Date(String(v || ''));
  return isNaN(d) ? null : d;
}

/** Every <item> in the feed, normalised. Malformed items are skipped, not guessed. */
function parseFeed(xml) {
  const out = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const block = m[1];
    const title = tag(block, 'title');
    const link = tag(block, 'link');
    if (!title || !link) continue;
    out.push({
      title,
      link,
      description: tag(block, 'description') || null,
      published_at: parseDate(tag(block, 'pubDate')),
      department: departmentOf(link),
      guid: tag(block, 'guid') || link
    });
  }
  return out;
}

/**
 * Is this item an OFS announcement?
 *
 * Deliberately generous: a missed OFS costs the desk a whole issue, a false positive
 * costs one glance. So the title phrase alone qualifies, and the department is used
 * to raise confidence rather than to exclude.
 */
function isOfs(item) {
  if (!item) return false;
  // Match the description too: NSE sometimes titles a circular by its subject line
  // and names the mechanism only in the body.
  return OFS_TITLE_RE.test(item.title || '') || OFS_TITLE_RE.test(item.description || '');
}

function confidence(item) {
  if (!isOfs(item)) return 0;
  const dept = OFS_DEPARTMENTS.indexOf(item.department) >= 0 ? 1 : 0;
  const proposed = /proposed\s+offer\s+for\s+sale/i.test(item.title) ? 1 : 0;
  return 1 + dept + proposed;          // 1 = title only, 3 = the canonical shape
}

function classify(items) {
  return (items || []).map((i) => Object.assign({}, i, {
    is_ofs: isOfs(i),
    company: isOfs(i) ? companyOf(i.title) : null,
    confidence: confidence(i)
  }));
}

module.exports = {
  FEED_URL, OFS_DEPARTMENTS, OFS_TITLE_RE,
  parseFeed, classify, isOfs, confidence, companyOf, departmentOf, unescapeXml
};
