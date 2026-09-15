'use strict';
/**
 * Margin ledger. Phase 1 is a manual / CSV snapshot (ofs.ofs_margin) - REUSE.md 5:
 * the platform's routes/rms.js only WRITES RMS config; there is no available-margin
 * read API yet. Do not wire live margin until Ashika confirms one exists.
 */
const express = require('express');
const { SCHEMA, rows, one, query, tx } = require('../db/ofsAdapter');
const { requirePage, requireEdit, canViewPII } = require('../middleware/pageAccess');
const { maskRows } = require('../lib/pii');
const audit = require('../lib/audit');
const ld = require('../db/ldAdapter');
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
    /* A column of bare UCCs cannot be checked by eye, so the name comes from the
     * client master in one round trip. enrich() also attaches PAN, mobile and
     * email, and this was the only desk list that then sent them out with no
     * mask — every other one runs maskRows. A margin screen needs a name; it has
     * never needed a PAN. */
    res.json({
      margins: maskRows(await ld.enrich(r, 'client_ucc'), canViewPII(req, 'ofs-desk')),
      pii_unmasked: canViewPII(req, 'ofs-desk')
    });
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

/**
 * Write many margins at once, as SET operations rather than a loop.
 *
 * This is what made the CSV import fail with a gateway timeout. The old version
 * called upsert() once per row, and upsert() opens its own transaction: BEGIN,
 * SELECT, INSERT, INSERT, COMMIT. Five round trips per client, run one after
 * another. A 25,000-client snapshot is 125,000 round trips; nginx gives the
 * request 60 seconds and then returns 504, and the desk sees "Import failed" on
 * an upload that was still running and had already written part of the file.
 *
 * Now it is two statements for the whole batch, in one transaction, with the
 * values passed as arrays — so the cost is one round trip per chunk rather than
 * five per row, and the whole thing either lands or does not.
 *
 * Three details that matter:
 *
 *   `prev` is read in the same statement that writes, and every CTE sees the same
 *   snapshot, so old_value in the log is the value from BEFORE this upload even
 *   though the upsert is writing over it in the same breath.
 *
 *   A UCC listed twice in one CSV is a normal mistake, not a reason to fail the
 *   upload. ON CONFLICT cannot touch the same row twice in one statement, so the
 *   last value for a UCC wins and the earlier one is dropped — the same answer
 *   the row-by-row version gave, for the same reason.
 *
 *   The log insert reads from `prev`, not from `up`. Reading from a
 *   data-modifying CTE would only return the rows it actually wrote, which after
 *   a DO UPDATE is not the same set.
 */
async function upsertMany(c, batch, source, note, actor) {
  if (!batch.length) return 0;
  const uccs = batch.map((r) => r.ucc);
  const amts = batch.map((r) => r.available);
  const r = await c.query(
    `WITH incoming AS (
       SELECT DISTINCT ON (client_ucc) client_ucc, available
         FROM unnest($1::text[], $2::numeric[]) WITH ORDINALITY AS t(client_ucc, available, ord)
        ORDER BY client_ucc, ord DESC
     ),
     prev AS (
       SELECT i.client_ucc, i.available, m.available AS old_value
         FROM incoming i
         LEFT JOIN ${SCHEMA}.ofs_margin m ON m.client_ucc = i.client_ucc
     ),
     up AS (
       INSERT INTO ${SCHEMA}.ofs_margin
         (client_ucc, available, source, note, updated_by, updated_at)
       SELECT client_ucc, available, $3, $4, $5, now() FROM incoming
       ON CONFLICT (client_ucc) DO UPDATE
         SET available = EXCLUDED.available, source = EXCLUDED.source,
             note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING client_ucc
     )
     INSERT INTO ${SCHEMA}.ofs_margin_log
       (client_ucc, old_value, new_value, source, note, actor)
     SELECT client_ucc, old_value, available, $3, $4, $5 FROM prev
     RETURNING client_ucc`,
    [uccs, amts, source, note, actor]);
  return r.rowCount;
}

/* Chunked so one upload cannot build an unbounded statement, and so a very large
   file makes steady progress instead of one enormous transaction. */
const BULK_CHUNK = 2000;
const BULK_MAX = 50000;          // was 5000 rows, silently truncated

/** POST /api/margin/bulk  { rows: [{ucc, available}], source } */
router.post('/bulk', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const list = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!list.length) return res.status(400).json({ error: 'no_rows' });
    if (list.length > BULK_MAX) {
      return res.status(413).json({ error: 'too_many_rows',
        message: 'That file has ' + list.length + ' rows. Send at most ' + BULK_MAX +
                 ' at a time.' });
    }
    const actor = String(req.user.email || req.user.id);
    const source = req.body.source || 'csv';
    const note = req.body.note || null;

    // Cleaned and de-duplicated here as well as in SQL, so `skipped` can be
    // reported: a row the desk expected to see written and did not is worth
    // naming rather than silently dropping, which is what the loop used to do.
    const clean = [];
    let skipped = 0;
    for (const row of list) {
      const ucc = String(row.ucc || row.client_ucc || '').trim().toUpperCase();
      const amt = Number(row.available);
      if (!ucc || !isFinite(amt) || amt < 0) { skipped++; continue; }
      clean.push({ ucc, available: amt });
    }
    if (!clean.length) return res.status(400).json({ error: 'no_valid_rows', skipped });

    let n = 0;
    await tx(async (c) => {
      for (let i = 0; i < clean.length; i += BULK_CHUNK) {
        n += await upsertMany(c, clean.slice(i, i + BULK_CHUNK), source, note, actor);
      }
    });

    await audit.log(req, 'bulk_margin', 'ofs_margin', null, null,
      { count: n, skipped, rows_sent: list.length });
    res.json({ updated: n, skipped: skipped, rows_sent: list.length });
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

    // A count, not every row. This used to pull the whole non-zero margin table
    // into memory purely to report a number the write itself already knows.
    const before = await one(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.ofs_margin WHERE COALESCE(available,0) <> 0`);

    /* Two statements, not one per client. This had the same shape as the CSV
     * import and the same failure: one INSERT per non-zero margin, run one after
     * another inside a single transaction, so zeroing a day's 25,000 uploaded
     * margins ran past nginx's 60-second limit and came back 504 — after which
     * nobody could tell whether it had happened. */
    const out = await tx(async (c) => {
      const logged = await c.query(
        `INSERT INTO ${SCHEMA}.ofs_margin_log (client_ucc, old_value, new_value, source, note, actor)
         SELECT client_ucc, available, 0, 'reset', $1, $2
           FROM ${SCHEMA}.ofs_margin
          WHERE COALESCE(available,0) <> 0`, [note, actor]);
      if (keepZero) {
        await c.query(`DELETE FROM ${SCHEMA}.ofs_margin`);
      } else {
        await c.query(
          `UPDATE ${SCHEMA}.ofs_margin
              SET available = 0, source = 'reset', note = $1, updated_by = $2, updated_at = now()
            WHERE COALESCE(available,0) <> 0`, [note, actor]);
      }
      // What was actually logged, rather than what a read a moment earlier said.
      return logged.rowCount;
    });

    await audit.log(req, 'reset_margin', 'ofs_margin', null, { clients: (before && before.n) || 0 },
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
