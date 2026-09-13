'use strict';
/**
 * Exchange bid-file generation. One adapter per exchange (lib/exchange/*), so a
 * circular change is a mapping edit. Every file served is logged to ofs_export_log
 * with a sha256 of the exact bytes.
 */
const express = require('express');
const { SCHEMA, rows, one, query } = require('../db/ofsAdapter');
const { requirePage, requireEdit } = require('../middleware/pageAccess');
const { adapterFor, isExchange } = require('../lib/exchange');
const settings = require('../lib/settings');
const exportBuild = require('../lib/exportBuild');
const exportMailer = require('../lib/exportMailer');
const { istStamp } = require('../lib/exchange/common');
const audit = require('../lib/audit');

const router = express.Router();
const PAGE = 'ofs-desk';

/**
 * Which bids belong in THIS exchange's file.
 *
 * Until ofs_bid.exchange existed, none of this happened: the NSE file and the BSE
 * file were both built from every bid. An issue listed on NSE alone had its bids
 * written into the BSE file, and an issue listed on BOTH had every bid written into
 * both — so uploading both files submitted the same client twice, once to each
 * exchange.
 *
 * A bid with no exchange is included ONLY where its issue leaves no choice. On a
 * BOTH issue it is left out and named, because nobody has ever chosen for it and
 * guessing would route real money to an exchange no one picked.
 */
const buildFile = exportBuild.buildFile;
const collect = exportBuild.collect;
const unroutedBids = exportBuild.unroutedBids;

/** GET /api/export/:exchange/preview - table + totals, no log entry. */
router.get('/:exchange/preview', requirePage(PAGE), async (req, res, next) => {
  try {
    const out = await buildFile(req.params.exchange, req.query);
    const lines = out.text.split('\r\n').filter(Boolean);
    // Screen-only columns. These are deliberately NOT in out.text: an exchange file
    // carries the documented fields and nothing else, and one extra column is a
    // rejected upload. The desk still needs to see who placed each bid and when, so
    // it travels beside the file rather than in it — keyed by the ids the adapter
    // says it actually wrote, which is what keeps the two aligned across a 100-row
    // BSE part boundary.
    const byId = new Map((await collect(req.query, req.params.exchange)).map((b) => [String(b.id), b]));
    const meta = (out.bidIds || []).map((id) => {
      const b = byId.get(String(id)) || {};
      return {
        ref: b.ref || null,
        status: b.status || null,
        placed_by: b.placed_by || null,
        actor: b.placed_by_id || null,
        placed_at: istStamp(b.created_at),
        changed_at: istStamp(b.updated_at)
      };
    });
    res.json({
      exchange: out.exchange, file_name: out.fileName, header: out.header,
      meta,
      row_count: out.rowCount, total_qty: out.totalQty, total_value: out.totalValue,
      checksum: out.checksum,
      total_rows: out.totalRows == null ? out.rowCount : out.totalRows,
      parts: out.parts || 1,
      part: out.part || 1,
      max_rows_per_file: out.maxRowsPerFile || null,
      has_header_row: out.hasHeaderRow !== false,
      unverified: out.unverified || null,
      // Named, not dropped. A client who bid and is in neither file is the failure
      // nobody would notice until allotment day.
      unrouted: isExchange(req.params.exchange) ? await unroutedBids(req.query) : [],
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

/**
 * POST /api/export/email — send the day's files now.
 *
 * The same build and the same email the 15:16 job sends, on demand: so the desk can
 * prove the address and the attachments are right without waiting until tomorrow,
 * and so a day whose scheduled send failed can be put right by hand.
 *
 * Deliberately does NOT mark the day as sent. This is a copy, not a replacement —
 * if the desk sends one at 11:00 the scheduled one still goes at 15:16 with the
 * closed book, which is the one that matters.
 */
router.post('/email', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body && req.body.as_on || ''))
      ? String(req.body.as_on) : exportMailer.istDate();
    const out = await exportMailer.sendFor(day, null,
      'desk:' + (req.user.email || req.user.id));
    await audit.log(req, 'export_email', 'ofs_export', null, null, out);
    if (!out.sent && out.reason === 'no_recipient') {
      return res.status(422).json({ error: 'no_recipient',
        message: 'No address is set for exchange files. Add one in Masters \u2192 Settings.' });
    }
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
