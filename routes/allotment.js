'use strict';
/**
 * Post-bidding: import the exchange allotment/obligation file, compute per-client
 * allotment, queue client emails. The email send itself goes through the platform's
 * shared logger (REUSE.md 3) so it lands in Admin -> Email & OTP Logs.
 */
const express = require('express');
const { SCHEMA, rows, one, query, tx } = require('../db/ofsAdapter');
const ld = require('../db/ldAdapter');
const mailer = require('../lib/mailer');
const { allotmentEmail } = require('../lib/templates/allotment');
const { maskRows } = require('../lib/pii');
const { requirePage, requireEdit, canViewPII } = require('../middleware/pageAccess');
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

/** GET /api/allotment/mail/status - is SMTP usable? Drives the UI badge. */
router.get('/mail/status', requirePage(PAGE), async (req, res, next) => {
  try { res.json(await mailer.status()); } catch (e) { next(e); }
});

/** The pending queue for an issue, with LD name/email merged in. */
async function mailQueue(issueId) {
  const pending = await rows(
    `SELECT a.id, a.client_ucc, a.allot_qty, a.allot_price, a.allot_value,
            i.symbol, i.company, b.qty AS bid_qty, b.price AS bid_price
       FROM ${SCHEMA}.ofs_allotment a
       LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = a.issue_id
       LEFT JOIN ${SCHEMA}.ofs_bid   b ON b.id = a.bid_id
      WHERE a.issue_id = $1 AND a.mail_status = 'pending'
      ORDER BY a.client_ucc`, [issueId]);
  return ld.enrich(pending, 'client_ucc');
}

/**
 * POST /api/allotment/mail  { issue_id, confirm }
 *
 * Without confirm:true this returns the queue and sends NOTHING. These emails go
 * to real clients about real money, so the send is a deliberate second action —
 * the desk sees exactly who would be written to, and how many, first.
 *
 * Every send is recorded by lib/emailLog, so it appears in Admin -> Email & OTP Logs
 * next to every other platform email, and each row's mail_status is settled either way.
 */
router.post('/mail', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const issueId = req.body.issue_id;
    if (!issueId) return res.status(400).json({ error: 'missing_input' });

    const queue = await mailQueue(issueId);
    const sendable = queue.filter((q) => q.email);
    const missing = queue.filter((q) => !q.email);

    if (!req.body.confirm) {
      return res.json({
        preview: true,
        smtp: await mailer.status(),
        to_send: sendable.length,
        no_email: missing.length,
        queue: maskRows(queue, canViewPII(req, PAGE)),
        message: 'Nothing sent. Repeat with confirm:true to send.'
      });
    }

    const smtp = await mailer.status();
    if (!smtp.ok) return res.status(503).json({ error: 'smtp_unavailable', smtp });

    const actor = String(req.user.email || req.user.id);
    let sent = 0;
    const failed = [];

    for (const a of sendable) {
      const { subject, html } = allotmentEmail({
        client_name: a.client_name, client_ucc: a.client_ucc,
        symbol: a.symbol, company: a.company,
        bid_qty: a.bid_qty, bid_price: a.bid_price,
        allot_qty: a.allot_qty, allot_price: a.allot_price, allot_value: a.allot_value
      });
      const r = await mailer.send({
        to: a.email, subject, html,
        purpose: 'ofs_allotment', triggeredBy: actor, ip: req.ip
      });
      await query(
        `UPDATE ${SCHEMA}.ofs_allotment SET mail_status = $2, mail_at = now() WHERE id = $1`,
        [a.id, r.sent ? 'sent' : 'failed']);
      if (r.sent) sent++; else failed.push({ ucc: a.client_ucc, error: r.error });
    }

    // A client with no email on file is not a failure to retry — mark it skipped
    // so the queue settles and the desk can chase it separately.
    for (const a of missing) {
      await query(
        `UPDATE ${SCHEMA}.ofs_allotment SET mail_status = 'skipped', mail_at = now() WHERE id = $1`, [a.id]);
    }

    await audit.log(req, 'mail_allotment', 'ofs_allotment', issueId, null,
      { sent, failed: failed.length, skipped: missing.length });

    res.json({ sent, failed: failed.length, skipped: missing.length, errors: failed.slice(0, 20) });
  } catch (e) { next(e); }
});

/** Put failed rows back in the queue so a retry is possible after fixing SMTP. */
router.post('/mail/reset', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const issueId = req.body.issue_id;
    if (!issueId) return res.status(400).json({ error: 'missing_input' });
    const r = await query(
      `UPDATE ${SCHEMA}.ofs_allotment SET mail_status = 'pending'
        WHERE issue_id = $1 AND mail_status = 'failed'`, [issueId]);
    await audit.log(req, 'mail_reset', 'ofs_allotment', issueId, null, { requeued: r.rowCount });
    res.json({ requeued: r.rowCount });
  } catch (e) { next(e); }
});

module.exports = router;
