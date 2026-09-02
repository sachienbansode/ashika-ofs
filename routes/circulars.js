'use strict';
/**
 * The circular watch, from the OFS BackOffice.
 *
 * This is announcement detection, not data ingestion: it answers "is there an OFS we
 * have not set up?". The desk still opens the PDF and enters floor price and windows,
 * because those live in the circular, not in the feed.
 */
const express = require('express');
const { requirePage, requireEdit } = require('../middleware/pageAccess');
const watch = require('../lib/circularWatch');
const audit = require('../lib/audit');

const router = express.Router();
const PAGE = 'ofs-masters';

router.get('/', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    res.json({ circulars: await watch.list(req.query || {}), status: await watch.status() });
  } catch (e) { next(e); }
});

router.get('/status', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try { res.json(await watch.status()); } catch (e) { next(e); }
});

/** GET /api/circulars/runs — every check, newest first, with the totals. */
router.get('/runs', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    res.json({ runs: await watch.runs(req.query.limit), summary: await watch.runSummary() });
  } catch (e) { next(e); }
});

/** POST /api/circulars/poll — check the feed now, rather than waiting for the timer. */
router.post('/poll', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const out = await watch.poll({ force: true });
    await watch.recordRun(out, 'manual', String(req.user.email || req.user.id));
    await audit.log(req, 'circular_poll', 'ofs_circular', null, null, {
      status: out.status, items: out.items, new: out.inserted,
      issues_created: out.issues_made, alerted: out.alerted });
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * PUT /api/circulars/:id { status, note, issue_id }
 * reviewed = seen, no issue needed. imported = an issue was created from it.
 * ignored  = not an OFS after all, or not one Ashika is participating in.
 */
router.put('/:id(\\d+)', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const status = String((req.body && req.body.status) || '');
    if (['new', 'reviewed', 'imported', 'ignored'].indexOf(status) < 0) {
      return res.status(400).json({ error: 'bad_status' });
    }
    const r = await watch.setStatus(req.params.id, status,
      String(req.user.email || req.user.id),
      req.body.note || null, req.body.issue_id || null);
    if (!r) return res.status(404).json({ error: 'not_found' });
    await audit.log(req, 'circular_' + status, 'ofs_circular', String(r.id), null,
      { title: r.title, company: r.company, issue_id: r.issue_id });
    res.json({ circular: r });
  } catch (e) { next(e); }
});

module.exports = router;
