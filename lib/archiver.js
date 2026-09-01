'use strict';
/**
 * Archiving a closed OFS. Shared by the desk button and the scheduler, so both
 * behave identically and both leave the same audit trail.
 *
 * Archiving is a FLAG, never a move or a delete: bids, generated exchange files,
 * allotments and audit rows keep pointing at the same issue, so a closed OFS can be
 * opened in full years later. This is a regulated bidding record.
 */
const { SCHEMA, rows } = require('../db/ofsAdapter');
const settings = require('./settings');

/** Issues whose last window closed more than `days` ago and are still un-archived. */
async function candidates(days) {
  return rows(
    `SELECT id, symbol, company, exchange, greatest(hni_close, ret_close) AS closed_at
       FROM ${SCHEMA}.ofs_issue
      WHERE archived_at IS NULL
        AND greatest(hni_close, ret_close) < now() - ($1 || ' days')::interval
      ORDER BY greatest(hni_close, ret_close) DESC`, [String(days)]);
}

/**
 * Archive everything past the cut-off. Returns the rows archived, so the caller can
 * audit exactly which symbols moved rather than only a count.
 */
async function sweep({ actor, days, reason } = {}) {
  const after = Number(days != null ? days : (await settings.all()).archive_after_days || 7);
  const archived = await rows(
    `UPDATE ${SCHEMA}.ofs_issue
        SET archived_at = now(), archived_by = $1,
            archive_reason = $3
      WHERE archived_at IS NULL
        AND greatest(hni_close, ret_close) < now() - ($2 || ' days')::interval
      RETURNING id, symbol, company, exchange, greatest(hni_close, ret_close) AS closed_at`,
    [String(actor || 'system'), String(after),
     reason || ('closed more than ' + after + ' day(s) ago')]);
  return { after_days: after, archived };
}

module.exports = { candidates, sweep };
