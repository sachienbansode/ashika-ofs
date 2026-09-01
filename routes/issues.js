'use strict';
/** OFS issue master (the scrip master). Phase 1: manual / CSV ingestion. */
const express = require('express');
const { SCHEMA, rows, one, query } = require('../db/ofsAdapter');
const { requirePage, requireEdit, canViewPII } = require('../middleware/pageAccess');
const { maskRows } = require('../lib/pii');
const settings = require('../lib/settings');
const { issueStatus, catStatus } = require('../lib/domain');
const audit = require('../lib/audit');
const { sourceFor } = require('../lib/issueSource');
const runner = require('../lib/syncRunner');
const scheduler = require('../lib/syncScheduler');
const { upsertIssues } = require('../lib/issueSync');

const router = express.Router();
const PAGE = 'ofs-masters';

const COLS = `id, symbol, company, isin, series, exchange, bse_scrip_code,
  floor_price, cut_price_min, tick, lot, issue_qty, retail_qty, discount_pct, cutoff_flag,
  hni_open, hni_close, ret_open, ret_close, issue_date, indicative_ri, indicative_ni,
  status, source, created_by, created_at, updated_at`;

function decorate(r) {
  return Object.assign({}, r, {
    status_label: issueStatus(r),
    hni_status: catStatus(r, 'HNI'),
    ret_status: catStatus(r, 'Retail')
  });
}

router.get('/', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const open = String(req.query.open || '') === '1';
    const r = await rows(
      `SELECT ${COLS} FROM ${SCHEMA}.ofs_issue
        ${open
          ? "WHERE archived_at IS NULL AND status <> 'Closed' AND greatest(hni_close, ret_close) > now() - interval '1 day'"
          : 'WHERE archived_at IS NULL'}
        ORDER BY greatest(hni_close, ret_close) DESC, symbol`
    );
    res.json({ issues: r.map(decorate) });
  } catch (e) { next(e); }
});

router.get('/:id(\\d+)', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const r = await one(`SELECT ${COLS} FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json({ issue: decorate(r) });
  } catch (e) { next(e); }
});

const FIELDS = ['symbol','company','isin','series','exchange','bse_scrip_code','floor_price','cut_price_min',
  'tick','lot','issue_qty','retail_qty','discount_pct','cutoff_flag','hni_open','hni_close','ret_open','ret_close','issue_date',
  'indicative_ri','indicative_ni','status'];

function pick(body) {
  const out = {};
  for (const f of FIELDS) if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  return out;
}

router.post('/', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const v = pick(req.body || {});
    for (const req_f of ['symbol','company','isin','floor_price','hni_open','hni_close','ret_open','ret_close']) {
      if (!v[req_f]) return res.status(400).json({ error: 'missing_field', field: req_f });
    }
    if (v.cut_price_min == null) v.cut_price_min = v.floor_price;
    const keys = Object.keys(v);
    const r = await one(
      `INSERT INTO ${SCHEMA}.ofs_issue (${keys.join(',')}, created_by)
       VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}, $${keys.length + 1})
       RETURNING ${COLS}`,
      keys.map((k) => v[k]).concat([req.user.email || String(req.user.id)])
    );
    await audit.log(req, 'create', 'ofs_issue', r.id, null, r);
    res.status(201).json({ issue: decorate(r) });
  } catch (e) { next(e); }
});

router.put('/:id(\\d+)', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const before = await one(`SELECT ${COLS} FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found' });
    const v = pick(req.body || {});
    const keys = Object.keys(v);
    if (!keys.length) return res.json({ issue: decorate(before) });
    const r = await one(
      `UPDATE ${SCHEMA}.ofs_issue SET ${keys.map((k, i) => k + ' = $' + (i + 1)).join(', ')}
        WHERE id = $${keys.length + 1} RETURNING ${COLS}`,
      keys.map((k) => v[k]).concat([req.params.id])
    );
    await audit.log(req, 'update', 'ofs_issue', r.id, before, r);
    res.json({ issue: decorate(r) });
  } catch (e) { next(e); }
});

router.delete('/:id(\\d+)', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const before = await one(`SELECT ${COLS} FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found' });
    const used = await one(`SELECT count(*)::int AS n FROM ${SCHEMA}.ofs_bid WHERE issue_id = $1`, [req.params.id]);
    if (used.n > 0) return res.status(409).json({ error: 'has_bids', bids: used.n });
    await query(`DELETE FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [req.params.id]);
    await audit.log(req, 'delete', 'ofs_issue', req.params.id, before, null);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * GET /api/issues/sync/preview?exchange=BSE — fetch and report, write nothing.
 * The desk sees what would land before anything does.
 */
router.get('/sync/preview', requirePage(PAGE), async (req, res, next) => {
  try {
    const src = sourceFor(req.query.exchange || 'BSE');
    const out = await src.fetchIssues();
    res.json({
      exchange: src.EXCHANGE,
      source: out.source,
      found: out.issues.length,
      issues: out.issues,
      rejected: out.rejected.map((r) => ({ reason: r.reason })),
      reachable: out.attempts.some((a) => a.ok),
      attempts: out.attempts.map((a) => ({
        url: a.url, status: a.status, rows: a.rows, error: a.error
      }))
    });
  } catch (e) { next(e); }
});

/** POST /api/issues/sync { exchange } — fetch and write. */
router.post('/sync', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const src = sourceFor((req.body && req.body.exchange) || 'BSE');
    const out = await src.fetchIssues();

    if (!out.source) {
      return res.status(502).json({
        error: 'exchange_unreachable',
        message: 'No endpoint returned usable issue data. Run `npm run fetch-issues -- --raw` on the server to see what came back.',
        attempts: out.attempts.map((a) => ({ url: a.url, status: a.status, error: a.error }))
      });
    }

    const r = await upsertIssues(out.issues, String(req.user.email || req.user.id));
    await audit.log(req, 'sync_issues', 'ofs_issue', null, null,
      { exchange: src.EXCHANGE, source: out.source, ...r, skippedRows: out.rejected.length });

    res.json({
      exchange: src.EXCHANGE, source: out.source,
      found: out.issues.length, inserted: r.inserted, updated: r.updated,
      unchanged: r.skipped, rejected: out.rejected.length, detail: r.detail
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------- exchange pull --
 * A pull walks several endpoints per exchange and can take a minute, so it is a
 * ROW the desk polls rather than a request the browser waits on. See lib/syncRunner.js.
 */

/** POST /api/issues/sync/run { exchanges:['NSE','BSE'] } — start one, return its id. */
router.post('/sync/run', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    await runner.reapStale(15);
    const { run, busy } = await runner.start({
      exchanges: (req.body && req.body.exchanges) || (await settings.all()).sync_exchanges,
      trigger: 'manual',
      actor: String(req.user.email || req.user.id)
    });
    if (busy) return res.status(202).json({ ok: true, busy: true, run_id: run.id, run });

    runner.run(run);                       // deliberately not awaited
    await audit.log(req, 'sync_start', 'ofs_sync_run', String(run.id), null,
      { exchanges: run.exchanges });
    res.status(202).json({ ok: true, busy: false, run_id: run.id, run });
  } catch (e) { next(e); }
});

/** GET /api/issues/sync/runs/:id — progress + summary while it runs and after. */
router.get('/sync/runs/:id(\\d+)', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const run = await runner.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    res.json({ run });
  } catch (e) { next(e); }
});

/** GET /api/issues/sync/runs — the last few pulls. */
router.get('/sync/runs', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try { res.json({ runs: await runner.recent(req.query.limit) }); }
  catch (e) { next(e); }
});

/** GET /api/issues/sync/status — schedule, next run, market state, live run. */
router.get('/sync/status', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try { res.json(await scheduler.status()); }
  catch (e) { next(e); }
});

/* ------------------------------------------------------------------ archive --
 * Archiving is a flag, never a move or a delete: bids, exported files, allotments
 * and audit rows keep pointing at the same issue, so a closed OFS can be opened in
 * full years later. This is a regulated bidding record.
 */

/** Issues whose windows closed long enough ago to be worth archiving. */
router.get('/archive/candidates', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const days = Number((await settings.all()).archive_after_days || 7);
    const r = await rows(
      `SELECT * FROM ${SCHEMA}.ofs_issue_summary
        WHERE archived_at IS NULL
          AND greatest(hni_close, ret_close) < now() - ($1 || ' days')::interval
        ORDER BY greatest(hni_close, ret_close) DESC`, [String(days)]);
    res.json({ after_days: days, candidates: r });
  } catch (e) { next(e); }
});

/** The archive itself, newest first, with every figure the issue ever had. */
router.get('/archive', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const p = [];
    let where = 'WHERE archived_at IS NOT NULL';
    if (req.query.q) {
      p.push('%' + String(req.query.q).trim().toUpperCase() + '%');
      where += ` AND (upper(symbol) LIKE $${p.length} OR upper(company) LIKE $${p.length}
                      OR upper(isin) LIKE $${p.length})`;
    }
    p.push(Math.min(Number(req.query.limit) || 100, 500));
    const r = await rows(
      `SELECT * FROM ${SCHEMA}.ofs_issue_summary ${where}
        ORDER BY archived_at DESC LIMIT $${p.length}`, p);
    res.json({ archived: r });
  } catch (e) { next(e); }
});

/** Everything about one issue — live or archived. The permanent record. */
router.get('/:id(\\d+)/summary', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const issue = await one(
      `SELECT * FROM ${SCHEMA}.ofs_issue_summary WHERE id = $1`, [req.params.id]);
    if (!issue) return res.status(404).json({ error: 'not_found' });

    const [bids, exports_, allotments, trail] = await Promise.all([
      rows(`SELECT ref, client_ucc, category, qty, price, is_cutoff, value, status,
                   placed_by, created_at, updated_at
              FROM ${SCHEMA}.ofs_bid WHERE issue_id = $1 ORDER BY created_at`, [req.params.id]),
      rows(`SELECT exchange, file_name, row_count, total_qty, total_value, checksum,
                   generated_by, generated_at
              FROM ${SCHEMA}.ofs_export_log WHERE issue_id = $1 ORDER BY generated_at`, [req.params.id]),
      rows(`SELECT client_ucc, allot_qty, allot_price, allot_value, mail_status, allotted_at
              FROM ${SCHEMA}.ofs_allotment WHERE issue_id = $1 ORDER BY client_ucc`, [req.params.id]),
      rows(`SELECT actor, action, before, after, at FROM ${SCHEMA}.ofs_audit
             WHERE entity = 'ofs_issue' AND entity_id = $1 ORDER BY at`, [String(req.params.id)])
    ]);

    // PII is masked here as everywhere: an archive is not a way around it.
    res.json({
      issue,
      bids: maskRows(bids, canViewPII(req, 'ofs-desk')),
      exports: exports_,
      allotments,
      audit: trail,
      pii_unmasked: canViewPII(req, 'ofs-desk')
    });
  } catch (e) { next(e); }
});

router.post('/:id(\\d+)/archive', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const before = await one(`SELECT id, symbol, archived_at FROM ${SCHEMA}.ofs_issue WHERE id = $1`,
      [req.params.id]);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.archived_at) return res.json({ ok: true, already: true });

    // Refuse while bidding could still happen — archiving a live issue hides it
    // from the desk mid-window.
    const live = await one(
      `SELECT 1 AS x FROM ${SCHEMA}.ofs_issue
        WHERE id = $1 AND greatest(hni_close, ret_close) > now()`, [req.params.id]);
    if (live && !req.body.force) {
      return res.status(409).json({ error: 'still_open',
        message: 'This issue has not closed yet. Pass force to archive it anyway.' });
    }

    const r = await one(
      `UPDATE ${SCHEMA}.ofs_issue
          SET archived_at = now(), archived_by = $2, archive_reason = $3
        WHERE id = $1 RETURNING id, symbol, archived_at`,
      [req.params.id, String(req.user.email || req.user.id),
       (req.body && req.body.reason) ? String(req.body.reason).slice(0, 300) : 'window closed']);

    await audit.log(req, 'archive', 'ofs_issue', r.id, before, r);
    res.json({ ok: true, issue: r });
  } catch (e) { next(e); }
});

router.post('/:id(\\d+)/unarchive', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const r = await one(
      `UPDATE ${SCHEMA}.ofs_issue
          SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
        WHERE id = $1 RETURNING id, symbol`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    await audit.log(req, 'unarchive', 'ofs_issue', r.id, null, r);
    res.json({ ok: true, issue: r });
  } catch (e) { next(e); }
});

/** Archive everything past the cut-off age in one go. */
router.post('/archive/run', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const days = Number(req.body.after_days || (await settings.all()).archive_after_days || 7);
    const r = await rows(
      `UPDATE ${SCHEMA}.ofs_issue
          SET archived_at = now(), archived_by = $1, archive_reason = 'auto: closed over ' || $2 || ' days'
        WHERE archived_at IS NULL
          AND greatest(hni_close, ret_close) < now() - ($2 || ' days')::interval
        RETURNING id, symbol`,
      [String(req.user.email || req.user.id), String(days)]);
    await audit.log(req, 'archive_run', 'ofs_issue', null, null,
      { after_days: days, archived: r.length, symbols: r.map((x) => x.symbol) });
    res.json({ archived: r.length, issues: r, after_days: days });
  } catch (e) { next(e); }
});

module.exports = router;
