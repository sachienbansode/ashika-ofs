'use strict';
/**
 * What the NSE circular feed actually returns from THIS server.
 *
 *   npm run check-feed
 *
 * Prints the status, latency, caching headers and what parsed out of it. Use it when
 * the Circulars tab reports a failure and you want to see the raw truth without the
 * application in the way.
 */
require('dotenv').config();
const feed = require('../lib/circularFeed');

const UA = process.env.NSE_FEED_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
   + 'Chrome/124.0.0.0 Safari/537.36';

(async () => {
  console.log('GET', feed.FEED_URL);
  console.log('UA ', UA.slice(0, 60) + '…');

  const began = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);

  let res;
  try {
    res = await fetch(feed.FEED_URL, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/xml,text/xml,application/rss+xml,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow',
      signal: ctl.signal
    });
  } catch (e) {
    const code = (e.cause && e.cause.code) || e.code || e.name;
    console.error('\nFAILED after', Date.now() - began, 'ms —', code, '—', e.message);
    console.error('\nIf this is a timeout, NSE most likely stalled the connection rather than');
    console.error('a firewall blocking it. Compare:');
    console.error('  curl -sS -m 15 -o /dev/null -w "%{http_code}\\n" -H "User-Agent: Mozilla/5.0" \\');
    console.error('    ' + feed.FEED_URL);
    process.exitCode = 1;
    return;
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - began;
  const xml = await res.text();
  console.log('\nHTTP', res.status, 'in', ms, 'ms —', xml.length, 'bytes');
  console.log('etag         :', res.headers.get('etag') || '(none)');
  console.log('last-modified:', res.headers.get('last-modified') || '(none)');

  if (!res.ok) {
    console.error('\nNSE refused this server. 403 means their edge is blocking it, not that we');
    console.error('lack permission — the feed is public.');
    process.exitCode = 1;
    return;
  }

  const items = feed.classify(feed.parseFeed(xml));
  const ofs = items.filter((i) => i.is_ofs);

  console.log('\nparsed  :', items.length, 'circular(s)');
  console.log('matched :', ofs.length, 'Offer for Sale');
  console.log('depts   :', [...new Set(items.map((i) => i.department).filter(Boolean))].join(', ') || '(none)');

  if (!items.length) {
    console.error('\nNothing parsed. The response was not the feed we expect — first 300 bytes:');
    console.error(xml.slice(0, 300));
    process.exitCode = 1;
    return;
  }

  console.log('\nnewest:');
  items.slice(0, 5).forEach((i) => console.log('  ', (i.department || '??').padEnd(5), i.title.slice(0, 74)));

  if (ofs.length) {
    console.log('\nOFS matches:');
    ofs.forEach((i) => console.log('  ', i.company || '(company not parsed)', '—', i.title.slice(0, 60)));
  } else {
    console.log('\nNo Offer for Sale in the current window. That is normal between issues —');
    console.log('the feed is a rolling window, not an archive.');
  }
})();
