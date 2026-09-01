'use strict';
/**
 * Margin ledger. Phase 1 is a manual / CSV snapshot (ofs.ofs_margin) - REUSE.md 5:
 * the platform's routes/rms.js only WRITES RMS config; there is no available-margin
 * read API yet. Do not wire live margin until Ashika confirms one exists.
 */
const express = require('express');
const { SCHEMA, rows, one, query, tx } = require('../db/ofsAdapter');
const { requirePage, requireEdit } = require('../middleware/pageAccess');
const audit = require('../lib/audit');

const router = express.Router();
const PAGE = 'ofs-masters';

router.get('/', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const r = await rows(
      `SELECT m.client_ucc, m.available, m.source, m.note, m.updated_by, m.updated_at,
              COALESCE(u.used,0) AS used, COALESCE(m.available,0) - COALESCE(u.used,0) AS free
         FROM ${SCHEMA}.ofs_margin m
         LEFT JOIN (SELECT client_ucc, sum(value) AS used FROM ${SCHEMA}.ofs_bid
                     WHERE status = 'Live' GROUP BY client_ucc) u ON u.client_ucc = m.client_ucc
        ORDER BY m.client_ucc`);
    res.json({ margins: r });
  } catch (e) { next(e); }
});

async function upsert(ucc, amount, source, note, actor) {
  return tx(async (c) => {
    const prev = (await c.query(`SELECT available FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`, [ucc])).rows[0];
    const r = (await c.query(
      `INSERT INTO ${SCHEMA}.ofs_margin (client_ucc, available, source, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (client_ucc) DO UPDATE
         SET available = EXCLUDED.available, source = EXCLUDED.source,
             note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`, [ucc, amount, source, note, actor])).rows[0];
    await c.query(
      `INSERT INTO ${SCHEMA}.ofs_margin_log (client_ucc, old_value, new_value, source, note, actor)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ucc, prev ? prev.available : null, amount, source, note, actor]);
    return r;
  });
}

router.put('/:ucc', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const ucc = String(req.params.ucc).trim().toUpperCase();
    const amount = Number(req.body.available);
    if (!isFinite(amount) || amount < 0) return res.status(400).json({ error: 'bad_amount' });
    const r = await upsert(ucc, amount, req.body.source || 'manual', req.body.note || null,
      String(req.user.email || req.user.id));
    await audit.log(req, 'set_margin', 'ofs_margin', ucc, null, r);
    res.json({ margin: r });
  } catch (e) { next(e); }
});

/** POST /api/margin/bulk  { rows: [{ucc, available}], source } */
router.post('/bulk', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const list = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!list.length) return res.status(400).json({ error: 'no_rows' });
    const actor = String(req.user.email || req.user.id);
    let n = 0;
    for (const row of list.slice(0, 5000)) {
      const ucc = String(row.ucc || row.client_ucc || '').trim().toUpperCase();
      const amt = Number(row.available);
      if (!ucc || !isFinite(amt) || amt < 0) continue;
      await upsert(ucc, amt, req.body.source || 'csv', req.body.note || null, actor);
      n++;
    }
    await audit.log(req, 'bulk_margin', 'ofs_margin', null, null, { count: n });
    res.json({ updated: n });
  } catch (e) { next(e); }
});

router.get('/:ucc/log', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const r = await rows(
      `SELECT * FROM ${SCHEMA}.ofs_margin_log WHERE client_ucc = $1 ORDER BY at DESC LIMIT 100`,
      [String(req.params.ucc).trim().toUpperCase()]);
    res.json({ log: r });
  } catch (e) { next(e); }
});

module.exports = router;
