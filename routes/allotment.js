'use strict';
/**
 * Post-bidding: import the exchange allotment/obligation file, compute per-client
 * allotment, queue client emails. The email send itself goes through the platform's
 * shared logger (REUSE.md 3) so it lands in Admin -> Email & OTP Logs.
 */
const express = require('express');
const { SCHEMA, rows, one, query, tx } = require('../db/ofsAdapter');
const { requirePage, requireEdit } = require('../middleware/pageAccess');
const audit = require('../lib/audit');

const router = express.Router();
const PAGE = 'ofs-desk';

router.get('/', requirePage(PAGE), async (req, res, next) => {
  try {
    const p = [];
    let where = '';
    if (req.query.issue_id) { p.push(req.query.issue_id); where = 'WHERE a.issue_id = $1'; }
    const r = await rows(
      `SELECT a.*, i.symbol, i.company, b.ref, b.qty AS bid_qty, b.price AS bid_price, b.category
         FROM ${SCHEMA}.ofs_allotment a
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = a.issue_id
         LEFT JOIN ${SCHEMA}.ofs_bid b   ON b.id = a.bid_id
        ${where} ORDER BY i.symbol, a.client_ucc`, p);
    res.json({ allotments: r });
  } catch (e) { next(e); }
});

/**
 * POST /api/allotment/import
 * { issue_id, rows: [{ ucc, allot_qty, allot_price }] }
 * Parsed client-side from the exchange file; the exact layout is confirmed with
 * Ashika (spec S3 checklist item "Allotment file") before a server-side parser is added.
 */
router.post('/import', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const issueId = req.body.issue_id;
    const list = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!issueId || !list.length) return res.status(400).json({ error: 'missing_input' });

    const issue = await one(`SELECT id, symbol FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [issueId]);
    if (!issue) return res.status(404).json({ error: 'unknown_issue' });

    const actor = String(req.user.email || req.user.id);
    const out = await tx(async (c) => {
      let n = 0;
      for (const r of list.slice(0, 20000)) {
        const ucc = String(r.ucc || r.client_ucc || '').trim().toUpperCase();
        const qty = Number(r.allot_qty || r.qty) || 0;
        const price = r.allot_price == null ? null : Number(r.allot_price);
        if (!ucc) continue;
        const bid = (await c.query(
          `SELECT id FROM ${SCHEMA}.ofs_bid WHERE issue_id = $1 AND client_ucc = $2
            ORDER BY (status='Live') DESC, created_at DESC LIMIT 1`, [issueId, ucc])).rows[0];
        await c.query(
          `INSERT INTO ${SCHEMA}.ofs_allotment
             (issue_id, bid_id, client_ucc, allot_qty, allot_price, allot_value, imported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (issue_id, client_ucc) DO UPDATE
             SET allot_qty = EXCLUDED.allot_qty, allot_price = EXCLUDED.allot_price,
                 allot_value = EXCLUDED.allot_value, imported_by = EXCLUDED.imported_by,
                 allotted_at = now(), mail_status = 'pending'`,
          [issueId, bid ? bid.id : null, ucc, qty, price, qty * (price || 0), actor]);
        n++;
      }
      return n;
    });

    await audit.log(req, 'import_allotment', 'ofs_allotment', issueId, null, { rows: out });
    res.json({ imported: out });
  } catch (e) { next(e); }
});

/**
 * POST /api/allotment/mail  { issue_id }
 * TODO(Phase 1 finish): call the platform mailer and lib/emailLog.logFromInfo so the
 * send is captured like every other platform email (REUSE.md 3). Until the shared
 * mailer module is vendored into this repo, this marks rows and returns the queue.
 */
router.post('/mail', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const issueId = req.body.issue_id;
    if (!issueId) return res.status(400).json({ error: 'missing_input' });
    const queue = await rows(
      `SELECT a.client_ucc, a.allot_qty, a.allot_price, a.allot_value, c.email, c.name, i.symbol
         FROM ${SCHEMA}.ofs_allotment a
         LEFT JOIN ${SCHEMA}.ofs_client c ON c.ucc = a.client_ucc
         LEFT JOIN ${SCHEMA}.ofs_issue i  ON i.id = a.issue_id
        WHERE a.issue_id = $1 AND a.mail_status = 'pending' AND a.allot_qty > 0`, [issueId]);
    res.status(501).json({
      error: 'mailer_not_wired',
      message: 'Shared platform mailer + lib/emailLog not yet vendored into the OFS repo.',
      queued: queue.length
    });
  } catch (e) { next(e); }
});

module.exports = router;
