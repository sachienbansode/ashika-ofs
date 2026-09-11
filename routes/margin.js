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
const dbErr = require('../lib/dbErrors');

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
  } catch (e) { dbErr.send(res, next, e); }
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
  } catch (e) { dbErr.send(res, next, e); }
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
  } catch (e) { dbErr.send(res, next, e); }
});

/**
 * DELETE /api/margin/:ucc — remove a client's margin record.
 *
 * The row goes; the history does not. ofs_margin_log keeps the value it held and
 * who removed it, because "what was their margin when that bid was placed?" has to
 * stay answerable months later, and a deleted row is exactly when someone asks.
 */
router.delete('/:ucc', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const ucc = String(req.params.ucc).trim().toUpperCase();
    const before = await one(`SELECT * FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`, [ucc]);
    if (!before) return res.status(404).json({ error: 'not_found',
      message: 'No margin record for ' + ucc + '.' });

    const live = await one(
      `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
        WHERE client_ucc = $1 AND status = 'Live'`, [ucc]);
    // Removing the margin behind a live bid leaves the bid uncovered and the desk
    // unable to see that it is. Say so rather than doing it quietly.
    if (Number(live && live.v) > 0 && String(req.body && req.body.force) !== 'true') {
      return res.status(409).json({ error: 'margin_in_use',
        used: Number(live.v),
        message: ucc + ' has live bids worth ' + Number(live.v).toFixed(2) +
          ' against this margin. Cancel them first, or confirm to remove it anyway.' });
    }

    await tx(async (c) => {
      await c.query(`DELETE FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`, [ucc]);
      await c.query(
        `INSERT INTO ${SCHEMA}.ofs_margin_log (client_ucc, old_value, new_value, source, note, actor)
         VALUES ($1,$2,NULL,'manual',$3,$4)`,
        [ucc, before.available, req.body && req.body.note ? String(req.body.note).slice(0, 300) : 'record removed',
         String(req.user.email || req.user.id)]);
    });

    await audit.log(req, 'delete_margin', 'ofs_margin', ucc, before, null);
    res.json({ ok: true, removed: ucc, was: before.available });
  } catch (e) { dbErr.send(res, next, e); }
});

/**
 * POST /api/margin/reset — every client's available margin to zero.
 *
 * Ashika's rule: margins start each day at zero, and the day's figures are uploaded
 * before bidding. A margin left over from last week must never be able to fund
 * today's bid, and the only way to guarantee that is to clear them rather than to
 * trust that someone re-uploaded.
 *
 * The schedule lives in the Stage API admin module, not here: one scheduler for the
 * platform is easier to see and to silence than a timer hidden inside each app. This
 * endpoint is what it calls, and it is equally usable by hand from Masters.
 *
 * Every row is logged individually to ofs_margin_log, so the morning after, "why was
 * this client at zero?" has an answer with a name and a time against it.
 */
router.post('/reset', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const actor = String(req.user.email || req.user.id);
    const note = String((req.body && req.body.note) || 'start-of-day reset').slice(0, 300);
    const keepZero = String((req.body && req.body.delete_rows) || '') === '1';

    const before = await rows(
      `SELECT client_ucc, available FROM ${SCHEMA}.ofs_margin WHERE COALESCE(available,0) <> 0`);

    const out = await tx(async (c) => {
      for (const m of before) {
        await c.query(
          `INSERT INTO ${SCHEMA}.ofs_margin_log (client_ucc, old_value, new_value, source, note, actor)
           VALUES ($1,$2,0,'reset',$3,$4)`, [m.client_ucc, m.available, note, actor]);
      }
      if (keepZero) {
        await c.query(`DELETE FROM ${SCHEMA}.ofs_margin`);
      } else {
        await c.query(
          `UPDATE ${SCHEMA}.ofs_margin
              SET available = 0, source = 'reset', note = $1, updated_by = $2, updated_at = now()
            WHERE COALESCE(available,0) <> 0`, [note, actor]);
      }
      return before.length;
    });

    await audit.log(req, 'reset_margin', 'ofs_margin', null, { clients: before.length },
      { zeroed: out, rows_deleted: keepZero });
    res.json({ ok: true, clients: out, rows_deleted: keepZero, at: new Date().toISOString() });
  } catch (e) { dbErr.send(res, next, e); }
});

router.get('/:ucc/log', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const r = await rows(
      `SELECT * FROM ${SCHEMA}.ofs_margin_log WHERE client_ucc = $1 ORDER BY at DESC LIMIT 100`,
      [String(req.params.ucc).trim().toUpperCase()]);
    res.json({ log: r });
  } catch (e) { dbErr.send(res, next, e); }
});

module.exports = router;
