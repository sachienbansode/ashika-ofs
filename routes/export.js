'use strict';
/**
 * Exchange bid-file generation. One adapter per exchange (lib/exchange/*), so a
 * circular change is a mapping edit. Every file served is logged to ofs_export_log
 * with a sha256 of the exact bytes.
 */
const express = require('express');
const { SCHEMA, rows, one, query } = require('../db/ofsAdapter');
const { requirePage } = require('../middleware/pageAccess');
const { adapterFor } = require('../lib/exchange');
const settings = require('../lib/settings');
const audit = require('../lib/audit');

const router = express.Router();
const PAGE = 'ofs-desk';

async function collect(q) {
  const w = [], p = [];
  if (q.issue_id && q.issue_id !== 'all') { p.push(q.issue_id); w.push('b.issue_id = $' + p.length); }
  if (q.category && q.category !== 'all') { p.push(q.category); w.push('b.category = $' + p.length); }
  if (String(q.include_cancelled || '') === '1') w.push("b.status IN ('Live','Modified','Cancelled')");
  else w.push("b.status IN ('Live','Modified')");

  const r = await rows(
    `SELECT b.*, row_to_json(i) AS issue
       FROM ${SCHEMA}.ofs_bid b
       JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
      ORDER BY i.symbol, b.client_ucc, b.created_at`, p);
  return r;
}

async function buildFile(exchange, q) {
  const s = await settings.all();
  const adapter = adapterFor(exchange);
  const bids = await collect(q);
  let symbol = null;
  if (q.issue_id && q.issue_id !== 'all') {
    const i = await one(`SELECT symbol FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [q.issue_id]);
    symbol = i && i.symbol;
  }
  return adapter.build(bids, s, {
    symbol,
    memberCode: q.member_code,
    part: q.part,                      // BSE caps a file at 100 records
    pipe: String(q.pipe || '') === '1'
  });
}

/** GET /api/export/:exchange/preview - table + totals, no log entry. */
router.get('/:exchange/preview', requirePage(PAGE), async (req, res, next) => {
  try {
    const out = await buildFile(req.params.exchange, req.query);
    const lines = out.text.split('\r\n').filter(Boolean);
    res.json({
      exchange: out.exchange, file_name: out.fileName, header: out.header,
      row_count: out.rowCount, total_qty: out.totalQty, total_value: out.totalValue,
      checksum: out.checksum,
      total_rows: out.totalRows == null ? out.rowCount : out.totalRows,
      parts: out.parts || 1,
      part: out.part || 1,
      max_rows_per_file: out.maxRowsPerFile || null,
      has_header_row: out.hasHeaderRow !== false,
      preview: lines.slice(0, 51)
    });
  } catch (e) { next(e); }
});

/** GET /api/export/:exchange/download - serves the file and logs it. */
router.get('/:exchange/download', requirePage(PAGE), async (req, res, next) => {
  try {
    const out = await buildFile(req.params.exchange, req.query);
    if (!out.rowCount) return res.status(409).json({ error: 'no_rows' });

    await query(
      `INSERT INTO ${SCHEMA}.ofs_export_log
         (issue_id, exchange, format, file_name, row_count, total_qty, total_value, checksum, filters, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.query.issue_id && req.query.issue_id !== 'all' ? req.query.issue_id : null,
       out.exchange, out.format, out.fileName, out.rowCount, out.totalQty, out.totalValue,
       out.checksum,
       JSON.stringify(Object.assign({}, req.query,
         out.parts > 1 ? { _part: out.part, _parts: out.parts } : {})),
       String(req.user.email || req.user.id)]);

    await audit.log(req, 'export', 'ofs_export', out.fileName,
      null, { exchange: out.exchange, rows: out.rowCount, checksum: out.checksum });

    res.setHeader('Content-Type', out.mime + '; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + out.fileName + '"');
    res.setHeader('X-OFS-Checksum', out.checksum);
    res.setHeader('X-OFS-Rows', String(out.rowCount));
    if (out.parts > 1) {
      res.setHeader('X-OFS-Part', out.part + '/' + out.parts);
    }
    res.send(out.text);
  } catch (e) { next(e); }
});

router.get('/log', requirePage(PAGE), async (req, res, next) => {
  try {
    const r = await rows(
      `SELECT e.*, i.symbol FROM ${SCHEMA}.ofs_export_log e
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = e.issue_id
        ORDER BY e.generated_at DESC LIMIT 100`);
    res.json({ exports: r });
  } catch (e) { next(e); }
});

module.exports = router;
