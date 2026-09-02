require('dotenv').config();
const feed = require('./lib/circularFeed');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
(async () => {
  const t = Date.now();
  const res = await fetch(feed.FEED_URL, { headers: {
    'User-Agent': UA,
    Accept: 'application/xml,text/xml,application/rss+xml,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9', 'Cache-Control': 'no-cache' } });
  const xml = await res.text();
  const items = feed.classify(feed.parseFeed(xml));
  console.log('HTTP', res.status, 'in', Date.now() - t, 'ms,', xml.length, 'bytes');
  console.log('etag:', res.headers.get('etag'), '| last-modified:', res.headers.get('last-modified'));
  console.log('parsed items:', items.length, '| OFS matches:', items.filter(i => i.is_ofs).length);
  console.log('departments:', [...new Set(items.map(i => i.department))].join(', '));
  items.slice(0, 3).forEach(i => console.log('  -', i.department, '|', i.title.slice(0, 70)));
})().catch(e => console.error('FAILED:', e.message, '| cause:', e.cause && e.cause.code));
