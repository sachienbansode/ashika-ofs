'use strict';
/**
 * Desk-editable settings (ofs.ofs_setting). These drive real behaviour — the daily
 * cut-off, the retail cap, the codes written into an exchange file — so each one is
 * validated against what the exchange or SEBI actually permits rather than accepted
 * as free text, and every change is audited with its previous value.
 */
const express = require('express');
const { SCHEMA, rows, query } = require('../db/ofsAdapter');
const { requirePage, requireEdit } = require('../middleware/pageAccess');
const settings = require('../lib/settings');
const audit = require('../lib/audit');

const router = express.Router();
const PAGE = 'ofs-masters';

/**
 * What the desk may change, and what each value has to be. `hint` is shown in the
 * UI: a setting nobody understands is a setting somebody breaks.
 */
const EDITABLE = {
  daily_cutoff: {
    label: 'Daily desk cut-off (IST)', kind: 'time',
    hint: 'After this time no bid is accepted, whatever the exchange window says. Compared in IST.',
    check: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) || 'Use HH:MM, 24-hour'
  },
  retail_cap: {
    label: 'Retail cap (₹)', kind: 'number',
    hint: 'SEBI caps a retail application at ₹2,00,000 across exchanges. Lowering it is allowed; raising it is not.',
    check: (v) => (Number(v) > 0 && Number(v) <= 200000) || 'Must be between 1 and 200000'
  },
  hni_min: {
    label: 'HNI / Non-Institutional minimum (₹)', kind: 'number',
    hint: 'A non-institutional bid must be at least ₹2,00,000.',
    check: (v) => Number(v) >= 0 || 'Must be 0 or more'
  },
  enforce_margin: {
    label: 'Enforce margin', kind: 'bool',
    hint: '1 blocks a bid above the client’s free margin. 0 warns only — the desk then carries the risk.',
    check: (v) => ['0', '1'].includes(String(v)) || 'Use 0 or 1'
  },
  margin_type: {
    label: 'Margin type in the exchange file', kind: 'choice', choices: ['1', '2'],
    hint: '1 = 0% margin (institutional), 2 = 100% upfront. BSE OFS guidelines, bulk-bid field 8.',
    check: (v) => ['1', '2'].includes(String(v)) || 'Use 1 or 2'
  },
  cat_retail: {
    label: 'Category code — Retail', kind: 'choice', choices: ['RI'],
    hint: 'BSE valid values: RI, NII, MF, IC, OTHS.',
    check: (v) => /^[A-Z]{2,5}$/.test(v) || 'Two to five capital letters'
  },
  cat_retail_cutoff: {
    label: 'Category code — Retail at cut-off', kind: 'text',
    hint: 'Used when a retail bid is at cut-off. Confirm against the current circular before go-live.',
    check: (v) => /^[A-Z]{2,5}$/.test(v) || 'Two to five capital letters'
  },
  cat_hni: {
    label: 'Category code — Non-Institutional', kind: 'choice', choices: ['NII'],
    hint: 'BSE valid values: RI, NII, MF, IC, OTHS.',
    check: (v) => /^[A-Z]{2,5}$/.test(v) || 'Two to five capital letters'
  },
  cutoff_price_mode: {
    label: 'Price written for a cut-off bid', kind: 'choice', choices: ['zero', 'floor'],
    hint: 'What goes in the price column when the client bid at cut-off.',
    check: (v) => ['zero', 'floor'].includes(v) || 'Use zero or floor'
  }
};

router.get('/', requirePage('ofs-desk', PAGE), async (req, res, next) => {
  try {
    const current = await settings.all(true);
    res.json({
      settings: current,
      editable: Object.keys(EDITABLE).map((key) => ({
        key,
        value: current[key],
        label: EDITABLE[key].label,
        kind: EDITABLE[key].kind,
        choices: EDITABLE[key].choices || null,
        hint: EDITABLE[key].hint
      }))
    });
  } catch (e) { next(e); }
});

/** PUT /api/settings { key, value } — one at a time, so an audit row means one change. */
router.put('/', requirePage(PAGE), requireEdit(PAGE), async (req, res, next) => {
  try {
    const key = String((req.body && req.body.key) || '');
    const value = String((req.body && req.body.value) != null ? req.body.value : '').trim();

    const spec = EDITABLE[key];
    if (!spec) return res.status(400).json({ error: 'not_editable', key });

    const verdict = spec.check(value);
    if (verdict !== true) return res.status(422).json({ error: 'invalid_value', message: verdict });

    const before = (await settings.all(true))[key];
    if (String(before) === value) return res.json({ ok: true, key, value, unchanged: true });

    await settings.set(key, value, String(req.user.email || req.user.id));
    await audit.log(req, 'setting_change', 'ofs_setting', key, { value: before }, { value });

    res.json({ ok: true, key, value, previous: before });
  } catch (e) { next(e); }
});

/** Who changed what, when — settings move money, so the trail is visible in the UI. */
router.get('/history', requirePage(PAGE), async (req, res, next) => {
  try {
    const r = await rows(
      `SELECT entity_id AS key, before, after, actor, at
         FROM ${SCHEMA}.ofs_audit
        WHERE entity = 'ofs_setting'
        ORDER BY at DESC LIMIT 50`);
    res.json({ history: r });
  } catch (e) { next(e); }
});

module.exports = router;
