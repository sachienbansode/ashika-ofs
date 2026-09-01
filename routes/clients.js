'use strict';
/** Read-through to LD via the ofs.ofs_client view. Masked unless the viewer has pii. */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { requirePage, canViewPII } = require('../middleware/pageAccess');
const { maskRow, maskRows } = require('../lib/pii');

const router = express.Router();
const PAGE = 'ofs-desk';

router.get('/', requirePage(PAGE), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const p = [];
    let where = '';
    if (q) {
      p.push('%' + q.toUpperCase() + '%');
      where = `WHERE upper(c.ucc) LIKE $1 OR upper(c.name) LIKE $1 OR upper(c.pan) LIKE $1
               OR right(regexp_replace(c.mobile,'[^0-9]','','g'),10) LIKE $1`;
    }
    p.push(limit);
    const r = await rows(
      `SELECT c.ucc, c.name, c.pan, c.mobile, c.email, c.branch, c.category, c.last_traded_date,
              COALESCE(m.available,0) AS available_margin, m.updated_at AS margin_at
         FROM ${SCHEMA}.ofs_client c
         LEFT JOIN ${SCHEMA}.ofs_margin m ON m.client_ucc = c.ucc
        ${where}
        ORDER BY c.ucc LIMIT $${p.length}`, p);
    res.json({ clients: maskRows(r, canViewPII(req, PAGE)), pii_unmasked: canViewPII(req, PAGE) });
  } catch (e) { next(e); }
});

router.get('/:ucc', requirePage(PAGE), async (req, res, next) => {
  try {
    const ucc = String(req.params.ucc).trim().toUpperCase();
    const c = await one(
      `SELECT c.*, COALESCE(m.available,0) AS available_margin, m.updated_at AS margin_at
         FROM ${SCHEMA}.ofs_client c
         LEFT JOIN ${SCHEMA}.ofs_margin m ON m.client_ucc = c.ucc
        WHERE c.ucc = $1`, [ucc]);
    if (!c) return res.status(404).json({ error: 'not_found' });
    const used = await one(
      `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid WHERE client_ucc = $1 AND status = 'Live'`, [ucc]);
    res.json({
      client: maskRow(c, canViewPII(req, PAGE)),
      margin_used: Number(used.v) || 0,
      free_margin: (Number(c.available_margin) || 0) - (Number(used.v) || 0),
      pii_unmasked: canViewPII(req, PAGE)
    });
  } catch (e) { next(e); }
});

module.exports = router;
