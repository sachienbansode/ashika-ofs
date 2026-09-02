'use strict';
/**
 * The audit trail, readable from the desk.
 *
 * Every write in this app already lands in ofs.ofs_audit — bids (placed by the
 * client, an AP or the back office), issue masters, settings, margins, exchange
 * files, allotment imports and mails, archiving, sign-ins. Until now it was only
 * readable in SQL, which means in practice it was not read at all. Compliance needs
 * to see it without a DBA.
 *
 * Read-only by construction: there is no write route here, and ofs_audit has no
 * UPDATE or DELETE path anywhere in the app.
 */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { requirePage } = require('../middleware/pageAccess');

const router = express.Router();
const PAGE = 'ofs-masters';

/**
 * Group the raw action/entity pairs into the areas a compliance reviewer thinks in,
 * rather than making them learn our table names.
 */
const AREAS = {
  bids:      { label: 'Bids',                entities: ['ofs_bid'] },
  masters:   { label: 'Issue master',        entities: ['ofs_issue', 'ofs_sync_run'] },
  settings:  { label: 'Settings',            entities: ['ofs_setting'] },
  margins:   { label: 'Margins',             entities: ['ofs_margin'] },
  exchange:  { label: 'Exchange files',      entities: ['ofs_export'] },
  allotment: { label: 'Allotment & mails',   entities: ['ofs_allotment'] },
  access:    { label: 'Sign-in',             entities: ['session'] }
};

/**
 * Who placed a bid — the desk, the client themselves, or their AP. It is recorded on
 * the bid row, so read it back out of the audit payload rather than guessing from
 * the actor string.
 */
function placedBy(row) {
  const a = row.after || row.before;
  if (!a || typeof a !== 'object') return null;
  const by = a.placed_by;
  return by === 'client' ? 'Client (self)'
       : by === 'ap' ? 'Authorised Partner'
       : by === 'desk' ? 'Back office'
       : null;
}

/**
 * GET /api/audit
 *   ?area=bids|masters|settings|margins|exchange|allotment|access
 *   ?entity=ofs_bid  ?entity_id=123  ?actor=someone@  ?action=modify
 *   ?placed_by=desk|client|ap  ?from=2026-09-01  ?to=2026-09-02
 *   ?q=free text   ?limit=100  ?offset=0
 */
router.get('/', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const q = req.query || {};
    const w = [], p = [];

    if (q.area && AREAS[q.area]) {
      p.push(AREAS[q.area].entities);
      w.push('a.entity = ANY($' + p.length + ')');
    }
    if (q.entity)    { p.push(String(q.entity));               w.push('a.entity = $' + p.length); }
    if (q.entity_id) { p.push(String(q.entity_id));            w.push('a.entity_id = $' + p.length); }
    if (q.action)    { p.push(String(q.action));               w.push('a.action = $' + p.length); }
    if (q.actor)     { p.push('%' + String(q.actor) + '%');    w.push('a.actor ILIKE $' + p.length); }
    if (q.from)      { p.push(String(q.from));                 w.push('a.at >= $' + p.length + '::timestamptz'); }
    if (q.to)        { p.push(String(q.to));                   w.push("a.at < ($" + p.length + "::date + 1)"); }
    if (q.placed_by) {
      p.push(String(q.placed_by));
      w.push("(a.after->>'placed_by' = $" + p.length + " OR a.before->>'placed_by' = $" + p.length + ')');
    }
    if (q.q) {
      p.push('%' + String(q.q) + '%');
      const n = '$' + p.length;
      w.push('(a.actor ILIKE ' + n + ' OR a.action ILIKE ' + n + ' OR a.entity ILIKE ' + n +
             ' OR a.entity_id ILIKE ' + n + ' OR a.after::text ILIKE ' + n + ' OR a.before::text ILIKE ' + n + ')');
    }

    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const limit = Math.min(Number(q.limit) || 100, 500);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const list = await rows(
      `SELECT a.id, a.actor, a.action, a.entity, a.entity_id, a.before, a.after, a.ip, a.at
         FROM ${SCHEMA}.ofs_audit a ${where}
        ORDER BY a.at DESC, a.id DESC
        LIMIT ${limit} OFFSET ${offset}`, p);

    const total = await one(`SELECT count(*)::int AS n FROM ${SCHEMA}.ofs_audit a ${where}`, p);

    res.json({
      total: total ? total.n : 0,
      limit, offset,
      areas: Object.keys(AREAS).map((k) => ({ key: k, label: AREAS[k].label })),
      entries: list.map((r) => Object.assign({ placed_by_label: placedBy(r) }, r))
    });
  } catch (e) { next(e); }
});

/** GET /api/audit/actions — what actually appears in this database, for the filter. */
router.get('/actions', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    res.json({
      actions: await rows(
        `SELECT action, entity, count(*)::int AS n, max(at) AS last_at
           FROM ${SCHEMA}.ofs_audit GROUP BY action, entity ORDER BY n DESC`)
    });
  } catch (e) { next(e); }
});

/** GET /api/audit/:id — one entry, with the full before/after. */
router.get('/:id(\\d+)', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM ${SCHEMA}.ofs_audit WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json({ entry: Object.assign({ placed_by_label: placedBy(r) }, r) });
  } catch (e) { next(e); }
});

module.exports = router;
