'use strict';
/** ofs.ofs_setting read-through cache with .env fallbacks. */
const { SCHEMA, rows, query } = require('../db/ofsAdapter');

const DEFAULTS = {
  retail_cap: process.env.OFS_RETAIL_CAP || '200000',
  hni_min: process.env.OFS_HNI_MIN || '200000',
  daily_cutoff: process.env.OFS_DAILY_CUTOFF || '15:15',
  enforce_margin: process.env.OFS_ENFORCE_MARGIN || '1',
  margin_type: '2',
  /* Which exchanges this desk is live on: 'NSE', 'BSE' or 'NSE,BSE'. e-OFS at NSE
     and the BSE OFS module are separate enablements and either can be pending, so
     the desk says which are usable and the bid form, the issue list and validateBid
     all obey it. Default is both — a setting nobody has touched must not be the
     thing that silently stops trading. */
  allowed_exchanges: process.env.OFS_ALLOWED_EXCHANGES || 'NSE,BSE',
  cat_retail: 'RI',
  cat_retail_cutoff: 'RIC',
  cat_hni: 'NII',
  nse_header_row: '1',
  nse_series_hni: 'IS',
  nse_series_retail: 'RS',
  cutoff_price_mode: 'floor',
  bid_otp_required: '1',
  /* Order confirmation email to the client and to whoever placed the bid. OFF by
     default and deliberately so: this database carries real investor addresses,
     and a UAT round that starts mailing them is not a mistake anyone can take
     back. The desk turns it on from Settings, and is asked to confirm first. */
  bid_email_confirm: '0',
  // '' means "whatever the app server's own flag says" — which is what every
  // deployment looks like until someone touches this screen.
  otp_mode_client: '',
  otp_mode_staff: '',
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
  circulars_alert_email: '',
  /* The day's exchange files, emailed to the desk. ON by default and at 15:16 IST
     — a minute after the 15:15 cut-off — because the point of it is that the
     upload does not wait for somebody to be at the screen. */
  export_email_enabled: '1',
  export_email_time: process.env.OFS_EXPORT_EMAIL_TIME || '15:16',
  export_email_to: '',
  export_email_last: ''
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

/**
 * The last settings we read, without awaiting.
 *
 * For the SYNCHRONOUS display paths only - the status chip on an issue row, which
 * is computed while a list is being shaped and cannot await. It is at most TTL out
 * of date and falls back to the defaults before the first read. Every path that
 * DECIDES anything - validateBid, the bid routes - awaits all() and gets the live
 * value; a chip that is thirty seconds stale is a cosmetic lag, a gate that is
 * thirty seconds stale is not acceptable.
 */
function cachedAll() { return cache || DEFAULTS; }

module.exports = { all, get, num, set, cachedAll, DEFAULTS };
