'use strict';
/**
 * Shared pg.Pool factory. The OFS app talks to TWO databases on the same box
 * (13.233.106.37):
 *   - ofs_bids            : OFS state, owned by this app          -> ofsAdapter
 *   - uat_ananta_staging  : LD/DWH + "admin-staging-api" (PROD)   -> anantaAdapter
 * Postgres cannot join across databases, so nothing here pretends they are one.
 *
 * Config precedence per connection: <PREFIX>_DATABASE_URL, else discrete
 * <PREFIX>_PG_* vars. A password given separately as <PREFIX>_PG_PASSWORD always
 * wins over one embedded in the URL, so the URL can be kept password-free.
 */
const { Pool } = require('pg');

function build(prefix, appName) {
  const url = process.env[prefix + '_DATABASE_URL'];
  const pw = process.env[prefix + '_PG_PASSWORD'];
  const ssl = String(process.env[prefix + '_PG_SSL'] || 'false') === 'true'
    ? { rejectUnauthorized: false } : false;
  const max = Number(process.env[prefix + '_PG_POOL_MAX'] || 10);

  const cfg = url
    ? { connectionString: url, ssl, max }
    : {
        host: process.env[prefix + '_PG_HOST'],
        port: Number(process.env[prefix + '_PG_PORT'] || 5432),
        database: process.env[prefix + '_PG_DATABASE'],
        user: process.env[prefix + '_PG_USER'],
        ssl, max
      };

  if (pw) cfg.password = pw;
  cfg.idleTimeoutMillis = 30000;
  cfg.connectionTimeoutMillis = 10000;
  cfg.application_name = appName;
  return cfg;
}

/** Describes a connection for logs and /readyz WITHOUT leaking credentials. */
function describe(prefix) {
  const url = process.env[prefix + '_DATABASE_URL'];
  if (url) {
    try {
      const u = new URL(url);
      return u.hostname + ':' + (u.port || 5432) + u.pathname;
    } catch (e) { return '<malformed ' + prefix + '_DATABASE_URL>'; }
  }
  return (process.env[prefix + '_PG_HOST'] || '?') + ':' +
         (process.env[prefix + '_PG_PORT'] || 5432) + '/' +
         (process.env[prefix + '_PG_DATABASE'] || '?');
}

function make(prefix, appName) {
  let pool = null;
  const get = () => {
    if (pool) return pool;
    pool = new Pool(build(prefix, appName));
    pool.on('error', (e) => console.error('[' + prefix.toLowerCase() + '] idle client error:', e.message));
    return pool;
  };
  const query = async (sql, params) => get().query(sql, params || []);
  return {
    prefix,
    label: () => describe(prefix),
    getPool: get,
    query,
    rows: async (sql, params) => (await query(sql, params)).rows,
    one: async (sql, params) => (await query(sql, params)).rows[0] || null,
    tx: async (fn) => {
      const c = await get().connect();
      try {
        await c.query('BEGIN');
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally { c.release(); }
    },
    close: async () => { if (pool) { await pool.end(); pool = null; } }
  };
}

module.exports = { make, describe };
