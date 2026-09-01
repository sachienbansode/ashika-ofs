'use strict';
/**
 * Shared pg.Pool factory. The OFS app talks to TWO databases on the same box
 * (13.233.106.37):
 *   - ofs_bids            : OFS state, owned by this app          -> ofsAdapter
 *   - uat_ananta_staging  : LD/DWH + "admin-staging-api" (PROD)   -> anantaAdapter
 * Postgres cannot join across databases, so nothing here pretends they are one.
 *
 * Config building lives in db/pgConfig.js so it is testable without a driver.
 */
const { Pool } = require('pg');
const { build, describe, fromUrl } = require('./pgConfig');

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

module.exports = { make, describe, build, fromUrl };
