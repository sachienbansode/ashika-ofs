'use strict';
/**
 * NSE circulars feed parsing. The samples below are the real shapes NSE publishes:
 * <item> with title, a direct archive link whose FILENAME carries the department,
 * and an RFC-822 pubDate. No <department> element exists — that is the whole reason
 * departmentOf() reads the link.
 *
 * A missed OFS costs the desk an entire issue, so matching is deliberately generous
 * and these tests pin both directions: what must match, and what must not.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../lib/circularFeed');

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>NSE Circulars</title>
  <item>
    <title>Proposed Offer for Sale by Coal India Limited</title>
    <link>https://nsearchives.nseindia.com/content/circulars/CMTR66123.zip</link>
    <pubDate>Wed, 26 May 2026 17:40:00 +0530</pubDate>
  </item>
  <item>
    <title><![CDATA[Offer for Sale - Hindustan Copper Limited & others]]></title>
    <link>https://nsearchives.nseindia.com/content/circulars/CMPT66130.pdf</link>
    <pubDate>Mon, 24 Aug 2026 18:02:00 +0530</pubDate>
  </item>
  <item>
    <title>Change in Market Lot of Security</title>
    <link>https://nsearchives.nseindia.com/content/circulars/CML66131.pdf</link>
    <pubDate>Tue, 25 Aug 2026 12:00:00 +0530</pubDate>
  </item>
  <item>
    <title>Missing link should be skipped</title>
    <pubDate>Tue, 25 Aug 2026 12:00:00 +0530</pubDate>
  </item>
</channel></rss>`;

test('items parse, and a malformed one is skipped rather than guessed', () => {
  const items = f.parseFeed(FEED);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Proposed Offer for Sale by Coal India Limited');
  assert.equal(items[0].link, 'https://nsearchives.nseindia.com/content/circulars/CMTR66123.zip');
  assert.equal(items[0].published_at.toISOString(), '2026-05-26T12:10:00.000Z');
});

test('the department comes out of the link filename, not a tag', () => {
  assert.equal(f.departmentOf('https://x/content/circulars/CMTR66123.zip'), 'CMTR');
  assert.equal(f.departmentOf('https://x/content/circulars/CMPT66130.pdf'), 'CMPT');
  assert.equal(f.departmentOf('https://x/content/circulars/CML66131.pdf'), 'CML');
  assert.equal(f.departmentOf('https://x/nothing-numeric.pdf'), null);
});

test('CDATA and entities are decoded', () => {
  const items = f.parseFeed(FEED);
  assert.equal(items[1].title, 'Offer for Sale - Hindustan Copper Limited & others');
});

test('OFS circulars match and unrelated ones do not', () => {
  const c = f.classify(f.parseFeed(FEED));
  assert.equal(c[0].is_ofs, true);
  assert.equal(c[1].is_ofs, true);
  assert.equal(c[2].is_ofs, false, 'a market-lot circular is not an OFS');
});

test('confidence separates the canonical shape from a bare title match', () => {
  const c = f.classify(f.parseFeed(FEED));
  assert.equal(c[0].confidence, 3);      // CMTR + "Proposed Offer for Sale"
  assert.equal(c[1].confidence, 2);      // CMPT, but not the "Proposed" wording
  assert.equal(c[2].confidence, 0);
  // Title-only, unknown department, still matched — a missed OFS is the worse error.
  assert.equal(f.confidence({ title: 'OFS bidding window', department: null }), 1);
});

test('the company is pulled out of the title, both orderings', () => {
  assert.equal(f.companyOf('Proposed Offer for Sale by Coal India Limited'), 'Coal India Limited');
  assert.equal(f.companyOf('Offer for Sale - Hindustan Copper Limited'), 'Hindustan Copper Limited');
  assert.equal(f.companyOf('Offer for Sale of shares by NHPC Limited'), 'NHPC Limited');
  assert.equal(f.companyOf('NLC India Limited - Offer for Sale'), 'NLC India Limited');
  assert.equal(f.companyOf('Proposed Offer for Sale by LIC (revised)'), 'LIC');
  assert.equal(f.companyOf('Change in Market Lot'), null);
});

test('an empty or junk feed yields nothing rather than throwing', () => {
  assert.deepEqual(f.parseFeed(''), []);
  assert.deepEqual(f.parseFeed('<html><body>not a feed</body></html>'), []);
  assert.deepEqual(f.parseFeed(null), []);
});
