'use strict';
/** ofs.ofs_setting read-through cache with .env fallbacks. */
const { SCHEMA, rows, query } = require('../db/ofsAdapter');

const DEFAULTS = {
  retail_cap: process.env.OFS_RETAIL_CAP || '200000',
  hni_min: process.env.OFS_HNI_MIN || '200000',
  daily_cutoff: process.env.OFS_DAILY_CUTOFF || '15:15',
  enforce_margin: process.env.OFS_ENFORCE_MARGIN || '1',
  margin_type: '2',
  cat_retail: 'RI',
  cat_retail_cutoff: 'RIC',
  cat_hni: 'NII',
  cutoff_price_mode: 'floor',
  market_open: process.env.OFS_MARKET_OPEN || '09:15',
  market_close: process.env.OFS_MARKET_CLOSE || '15:30',
  market_days: '1-5',
  trading_holidays: '',
  sync_enabled: '0',
  sync_every_minutes: '60',
  sync_exchanges: 'NSE,BSE',
  sync_market_only: '1',
  archive_auto: '1',
  archive_after_days: '7',
  client_login_unknown: 'reveal',
  circulars_enabled: '1',
  circulars_poll_minutes: '15',
  circulars_alert_email: ''
};

let cache = null, at = 0;
const TTL = 30 * 1000;

async function all(force) {
  if (!force && cache && Date.now() - at < TTL) return cache;
  let db = {};
  try {
    const r = await rows(`SELECT key, value FROM ${SCHEMA}.ofs_setting`);
    for (const row of r) db[row.key] = row.value;
  } catch (e) {
    console.warn('[settings] falling back to defaults:', e.message);
  }
  cache = Object.assign({}, DEFAULTS, db);
  at = Date.now();
  return cache;
}

async function get(key) { return (await all())[key]; }
async function num(key) { return Number((await all())[key]) || 0; }

async function set(key, value, actor) {
  await query(
    `INSERT INTO ${SCHEMA}.ofs_setting (key, value, updated_by, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, String(value), actor || null]
  );
  cache = null;
}

module.exports = { all, get, num, set, DEFAULTS };
