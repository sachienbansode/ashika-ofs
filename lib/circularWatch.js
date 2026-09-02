'use strict';
/**
 * Polling the NSE circulars feed, storing what is new, and telling someone.
 *
 * Deliberate behaviours:
 *  - Conditional GET. The feed's ETag/Last-Modified are kept in ofs_feed_state, so a
 *    poll every 15 minutes normally costs one 304 rather than a full download.
 *  - Insert-only on conflict. A circular already seen is never re-alerted, even if
 *    the feed re-lists it; the unique (source, guid) is what guarantees that.
 *  - The email is best-effort. A mail failure must never lose the row — the desk can
 *    still see the circular in the UI, which is the point.
 *
 * This app does NOT read the circular PDF. The desk opens it and fills in floor
 * price and windows. What this removes is the risk of not knowing an OFS exists.
 */
const { SCHEMA, rows, one, query } = require('../db/ofsAdapter');
const feed = require('./circularFeed');
const settings = require('./settings');
const mailer = require('./mailer');
const { brandedEmail } = require('./emailBranding');

const SOURCE = 'NSE';
const UA = process.env.NSE_FEED_UA
  || 'AshikaOFS/1.0 (+trading member; RSS reader; contact: it@ashikagroup.com)';

async function state() {
  return one(`SELECT * FROM ${SCHEMA}.ofs_feed_state WHERE source = $1`, [SOURCE]);
}

async function saveState(patch) {
  await query(
    `INSERT INTO ${SCHEMA}.ofs_feed_state (source, etag, last_modified, last_poll_at, last_ok_at, last_status, items_seen, last_error)
     VALUES ($1,$2,$3, now(), $4, $5, COALESCE($6,0), $7)
     ON CONFLICT (source) DO UPDATE SET
       etag          = COALESCE(EXCLUDED.etag, ${SCHEMA}.ofs_feed_state.etag),
       last_modified = COALESCE(EXCLUDED.last_modified, ${SCHEMA}.ofs_feed_state.last_modified),
       last_poll_at  = now(),
       last_ok_at    = COALESCE(EXCLUDED.last_ok_at, ${SCHEMA}.ofs_feed_state.last_ok_at),
       last_status   = EXCLUDED.last_status,
       items_seen    = ${SCHEMA}.ofs_feed_state.items_seen + COALESCE(EXCLUDED.items_seen, 0),
       last_error    = EXCLUDED.last_error`,
    [SOURCE, patch.etag || null, patch.lastModified || null, patch.okAt || null,
     patch.status == null ? null : patch.status, patch.seen || 0, patch.error || null]);
}

/** One poll. Returns { status, items, matched, inserted, alerted }. */
async function poll({ force } = {}) {
  const st = force ? null : await state();
  const headers = { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' };
  if (st && st.etag) headers['If-None-Match'] = st.etag;
  if (st && st.last_modified) headers['If-Modified-Since'] = st.last_modified;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let res;
  try {
    res = await fetch(feed.FEED_URL, { headers, redirect: 'follow', signal: ctl.signal });
  } catch (e) {
    await saveState({ status: 0, error: e.message });
    return { status: 0, error: e.message, items: 0, matched: 0, inserted: 0, alerted: 0 };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    await saveState({ status: 304, okAt: new Date() });
    return { status: 304, notModified: true, items: 0, matched: 0, inserted: 0, alerted: 0 };
  }
  if (!res.ok) {
    await saveState({ status: res.status, error: 'HTTP ' + res.status });
    return { status: res.status, error: 'HTTP ' + res.status, items: 0, matched: 0, inserted: 0, alerted: 0 };
  }

  const xml = await res.text();
  const items = feed.classify(feed.parseFeed(xml));
  const matched = items.filter((i) => i.is_ofs);

  // Store EVERY item, not only the OFS ones: it is the only way to answer "was there
  // a circular we failed to match?" when an OFS is missed. Non-OFS rows are marked
  // 'ignored' so they never reach the review queue.
  const fresh = [];
  for (const i of items) {
    const r = await one(
      `INSERT INTO ${SCHEMA}.ofs_circular
         (source, guid, title, link, department, company, published_at, is_ofs, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (source, guid) DO NOTHING
       RETURNING id, title, link, company, published_at, is_ofs`,
      [SOURCE, i.guid, i.title, i.link, i.department, i.company,
       i.published_at, i.is_ofs, i.is_ofs ? 'new' : 'ignored']);
    if (r && r.is_ofs) fresh.push(r);
  }

  await saveState({
    status: res.status, okAt: new Date(), seen: items.length,
    etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), error: null
  });

  const alerted = fresh.length ? await alert(fresh) : 0;
  return { status: res.status, items: items.length, matched: matched.length,
           inserted: fresh.length, alerted, fresh };
}

/** Email the desk about circulars it has not seen. Never throws. */
async function alert(fresh) {
  try {
    const to = String((await settings.all()).circulars_alert_email || '').trim();
    if (!to) return 0;

    const list = fresh.map((c) =>
      `<li style="margin:0 0 10px"><b>${esc(c.company || c.title)}</b><br>
       <span style="color:#6b7f9e;font-size:12px">${esc(c.title)}</span><br>
       <a href="${esc(c.link)}" style="color:#243f8e;font-size:12px">${esc(c.link)}</a></li>`).join('');

    const r = await mailer.send({
      to,
      subject: fresh.length === 1
        ? 'NSE OFS circular: ' + (fresh[0].company || fresh[0].title).slice(0, 80)
        : fresh.length + ' new NSE OFS circulars',
      html: brandedEmail(`
        <p style="margin:0 0 14px">NSE has published ${fresh.length === 1 ? 'a circular' : fresh.length + ' circulars'} that look${fresh.length === 1 ? 's' : ''} like an Offer for Sale:</p>
        <ul style="margin:0 0 18px;padding-left:18px">${list}</ul>
        <p style="margin:0 0 6px;color:#6b7f9e;font-size:12px">
          Open the circular, then set the issue up under Masters &rarr; Circulars in the OFS BackOffice.
          Floor price and windows are in the PDF; this alert does not read it.</p>`),
      purpose: 'ofs_circular_alert', triggeredBy: 'circular-watch'
    });
    if (!r.sent) return 0;

    await query(`UPDATE ${SCHEMA}.ofs_circular SET alerted_at = now() WHERE id = ANY($1)`,
      [fresh.map((c) => c.id)]);
    return fresh.length;
  } catch (e) {
    console.error('[circulars] alert failed:', e.message);
    return 0;
  }
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Everything the desk shows: the queue, the counts and the feed's health. */
async function status() {
  const s = await settings.all();
  const st = await state();
  const counts = await one(
    `SELECT count(*) FILTER (WHERE is_ofs)                          AS ofs,
            count(*) FILTER (WHERE is_ofs AND status = 'new')       AS unreviewed,
            count(*) FILTER (WHERE is_ofs AND status = 'imported')  AS imported,
            max(published_at) FILTER (WHERE is_ofs)                 AS latest
       FROM ${SCHEMA}.ofs_circular`);
  return {
    enabled: String(s.circulars_enabled || '1') === '1',
    poll_minutes: Math.max(5, Number(s.circulars_poll_minutes) || 15),
    alert_email: s.circulars_alert_email || '',
    feed_url: feed.FEED_URL,
    feed: st || null,
    counts: counts || {}
  };
}

async function list(q) {
  const w = [], p = [];
  if (String((q && q.all) || '') !== '1') w.push('is_ofs');
  if (q && q.status) { p.push(String(q.status)); w.push('status = $' + p.length); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  return rows(
    `SELECT * FROM ${SCHEMA}.ofs_circular ${where}
      ORDER BY published_at DESC NULLS LAST, id DESC LIMIT ${Math.min(Number(q && q.limit) || 100, 300)}`, p);
}

async function setStatus(id, status, actor, note, issueId) {
  return one(
    `UPDATE ${SCHEMA}.ofs_circular
        SET status = $2, handled_by = $3, handled_at = now(),
            note = COALESCE($4, note), issue_id = COALESCE($5, issue_id)
      WHERE id = $1 RETURNING *`,
    [id, status, actor || null, note || null, issueId || null]);
}

module.exports = { SOURCE, poll, status, list, setStatus, state };
