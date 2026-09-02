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
  market_open: {
    label: 'Market opens (IST)', kind: 'time',
    hint: 'No bid is accepted before this. Equity session normally starts 09:15.',
    check: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) || 'Use HH:MM, 24-hour'
  },
  market_close: {
    label: 'Market closes (IST)', kind: 'time',
    hint: 'Session end, normally 15:30. The daily desk cut-off above OVERRIDES this.',
    check: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v) || 'Use HH:MM, 24-hour'
  },
  market_days: {
    label: 'Trading days', kind: 'text',
    hint: '0 = Sunday. "1-5" is Monday to Friday. Commas and ranges both work.',
    check: (v) => /^[0-6](\s*[-,]\s*[0-6])*$/.test(String(v).trim()) || 'Digits 0-6, with , or -'
  },
  trading_holidays: {
    label: 'Trading holidays', kind: 'text',
    hint: 'Comma-separated YYYY-MM-DD. Bidding is closed all day on these dates.',
    check: (v) => (!String(v).trim() ||
      String(v).split(/[,\s;]+/).filter(Boolean).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))
      || 'Use YYYY-MM-DD dates separated by commas'
  },
  circulars_enabled: {
    label: 'Watch NSE circulars', kind: 'bool',
    hint: '1 polls the NSE circulars RSS feed for "Offer for Sale" announcements. Free, licensed, no scraping.',
    check: (v) => ['0', '1'].includes(String(v)) || 'Use 0 or 1'
  },
  circulars_poll_minutes: {
    label: 'Check circulars every (minutes)', kind: 'number',
    hint: 'Between 5 and 240. A poll is a conditional GET, so an unchanged feed costs one 304.',
    check: (v) => (Number(v) >= 5 && Number(v) <= 240) || 'Between 5 and 240'
  },
  circulars_alert_email: {
    label: 'Email alert for new OFS circulars', kind: 'text',
    hint: 'Who to tell when NSE publishes an OFS circular. Blank = no email, the queue is still shown.',
    check: (v) => (!String(v).trim() || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim()))
      || 'Enter one email address, or leave blank'
  },
  client_login_unknown: {
    label: 'Unknown sign-in identifier', kind: 'choice', choices: ['reveal', 'generic'],
    hint: 'reveal = tell the visitor "no client found" (kinder, and stops "I never got my OTP" calls). '
        + 'generic = answer identically whether or not it matched, so the page cannot be used to discover '
        + 'which mobiles and emails belong to clients.',
    check: (v) => ['reveal', 'generic'].includes(v) || 'Use reveal or generic'
  },
  archive_auto: {
    label: 'Archive expired issues automatically', kind: 'bool',
    hint: '1 archives an issue once its last window closed more than the number of days below. Nothing is deleted.',
    check: (v) => ['0', '1'].includes(String(v)) || 'Use 0 or 1'
  },
  archive_after_days: {
    label: 'Archive after (days closed)', kind: 'number',
    hint: '0 archives as soon as the window closes. 7 keeps a week of closed issues on the desk.',
    check: (v) => (Number(v) >= 0 && Number(v) <= 365) || 'Between 0 and 365'
  },
  sync_enabled: {
    label: 'Auto-pull from the exchanges', kind: 'bool',
    hint: '1 runs a pull on the schedule below. Needs EXCHANGE_WEB_FETCH=true to fetch anything.',
    check: (v) => ['0', '1'].includes(String(v)) || 'Use 0 or 1'
  },
  sync_every_minutes: {
    label: 'Pull every (minutes)', kind: 'number',
    hint: 'Between 5 and 1440. 60 = hourly.',
    check: (v) => (Number(v) >= 5 && Number(v) <= 1440) || 'Between 5 and 1440'
  },
  sync_exchanges: {
    label: 'Pull from', kind: 'choice', choices: ['NSE,BSE', 'NSE', 'BSE'],
    hint: 'Which exchanges a scheduled pull covers. A manual pull can still pick either.',
    check: (v) => /^(NSE|BSE)(,(NSE|BSE))*$/.test(String(v).toUpperCase()) || 'NSE, BSE or NSE,BSE'
  },
  sync_market_only: {
    label: 'Only pull while the market is open', kind: 'bool',
    hint: '1 holds the schedule outside session hours — nothing changes on the exchange overnight.',
    check: (v) => ['0', '1'].includes(String(v)) || 'Use 0 or 1'
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
