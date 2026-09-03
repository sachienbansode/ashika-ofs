'use strict';
/**
 * Turning a found circular into an issue the desk can finish.
 *
 * The rule that governs everything here: an automatically created issue is
 * PROVISIONAL. status = 'Suspended' and needs_review = true, so it is not biddable
 * and not visible to clients until a person has checked it against the PDF. A wrong
 * floor price that quietly became biddable would be far worse than no issue at all.
 *
 * What is filled in comes from lib/circularParse.js, and every field records the
 * snippet it was read from, so the reviewer can check a number without opening the
 * PDF and hunting for it.
 */
const { SCHEMA, one } = require('../db/ofsAdapter');
const parse = require('./circularParse');
const docs = require('./issueDocs');

const UA = process.env.NSE_FEED_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
   + 'Chrome/124.0.0.0 Safari/537.36';

const MAX_PDF = 6 * 1024 * 1024;

/** Fetch the circular and read it, when it is a PDF we can reach. */
async function readCircular(link) {
  const url = String(link || '');
  if (!/\.pdf(\?|$)/i.test(url)) {
    return { ok: false, reason: /\.zip(\?|$)/i.test(url)
      ? 'The circular is a ZIP archive; only PDFs are read automatically.'
      : 'The circular is not a PDF.' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
      redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return { ok: false, reason: 'The circular returned HTTP ' + res.status + '.' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PDF) return { ok: false, reason: 'The circular is larger than 6 MB.' };

    // Required lazily: a PDF library must never be able to stop the app booting.
    const pdf = require('pdf-parse');
    const parsed = await pdf(buf);
    return { ok: true, text: parsed.text || '', bytes: buf.length, pages: parsed.numpages };
  } catch (e) {
    return { ok: false, reason: 'Could not read the circular: ' + e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 09:15 and 15:30 IST on the given day — the standard session, to be corrected by hand. */
function session(day) {
  const d = new Date(day);
  const open = new Date(d.getTime() + (9 * 60 + 15) * 60000);
  const close = new Date(d.getTime() + (15 * 60 + 30) * 60000);
  return { open, close };
}

/** A symbol we can store when the PDF gave us none. Deliberately obvious. */
function provisionalSymbol(company, circularId) {
  const base = String(company || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return (base || 'CIRCULAR') + '-P' + circularId;
}

/**
 * Create the provisional issue. Returns { issue, extraction, skipped }.
 * Never throws for a parsing problem — a circular we cannot read still deserves a
 * placeholder row, because the alternative is the desk not knowing it exists.
 */
async function fromCircular(circular, opts = {}) {
  const read = await readCircular(circular.link);
  const ex = read.ok ? parse.extract(read.text) : { fields: {}, found: [], missing: ['(circular not read)'] };
  const f = ex.fields;

  const company = circular.company || (f.symbol && f.symbol.value) || circular.title.slice(0, 120);
  const symbol = (f.symbol && f.symbol.value) || provisionalSymbol(company, circular.id);
  const isin = (f.isin && f.isin.value) || 'ISIN-UNKNOWN';

  // Dates: use what was read; otherwise leave a window that is obviously a
  // placeholder rather than inventing a plausible one — tomorrow and the day after,
  // with the issue suspended so nothing can be bid into it.
  const base = f.hni_date ? new Date(f.hni_date.value)
    : new Date(Date.now() + 24 * 3600 * 1000);
  const retBase = f.ret_date ? new Date(f.ret_date.value)
    : new Date(base.getTime() + 24 * 3600 * 1000);
  const hni = session(base);
  const ret = session(retBase);

  const note = [
    'Created automatically from an NSE circular.',
    read.ok
      ? ('Read ' + ex.found.length + ' field(s) from the PDF: ' + (ex.found.join(', ') || 'none') + '.')
      : read.reason,
    ex.missing.length ? ('Still needed: ' + ex.missing.join(', ') + '.') : '',
    'Check every value against the circular before removing the suspension.'
  ].filter(Boolean).join(' ');

  const issue = await one(
    `INSERT INTO ${SCHEMA}.ofs_issue
       (symbol, company, isin, exchange, floor_price, cut_price_min, tick, lot,
        issue_qty, hni_open, hni_close, ret_open, ret_close,
        status, source, needs_review, review_note, created_by)
     VALUES ($1,$2,$3,'NSE',$4,$4,0.05,1,$5,$6,$7,$8,$9,'Suspended','circular',true,$10,$11)
     ON CONFLICT (upper(btrim(symbol)), upper(btrim(isin)), issue_date) DO NOTHING
     RETURNING *`,
    [symbol, company, isin,
     // NULL, not a placeholder. The floor may genuinely not be published yet (NSE
     // e-OFS FAQ v3.0 Q12), and 0.01 would read as a real floor of one paisa.
     (f.floor_price && f.floor_price.value) || null,
     (f.issue_qty && f.issue_qty.value) || null,
     hni.open, hni.close, ret.open, ret.close,
     note, opts.actor || 'circular-watch']);

  if (!issue) return { issue: null, extraction: ex, skipped: 'an issue for that symbol and day already exists' };

  // Attach the circular itself, so the numbers can be checked at source.
  try {
    await docs.addLink({
      issueId: issue.id, kind: 'circular', source: 'NSE',
      title: circular.title, url: circular.link, circularId: circular.id,
      actor: opts.actor || 'circular-watch'
    });
  } catch (e) { /* the issue matters more than the attachment */ }

  return { issue, extraction: ex, read: { ok: read.ok, pages: read.pages, reason: read.reason } };
}

module.exports = { fromCircular, readCircular, provisionalSymbol, session };
