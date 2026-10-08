'use strict';
/**
 * Shared pg.Pool factory. The OFS app talks to TWO databases on the same box,
 * whose address comes from .env and NOWHERE else — it has already changed once,
 * and an address written into a comment outranks nothing but still gets believed.
 * `npm run smoke` and the [boot] lines print the one actually in use:
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
  /* A connection failure has to name the connection.
   *
   * pg says "Connection terminated due to connection timeout" and stops there —
   * no host, no database, no hint of WHICH of the two this app uses. That line in
   * the log is true of a dead host, a firewall, a stale address still held by a
   * process that has not been restarted, and a pool with nothing free, and it
   * distinguishes none of them. Whoever reads it at 4am should not have to guess
   * which database the desk could not reach.
   */
  const CONN_FAIL = /connection timeout|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|terminated unexpectedly/i;
  const named = (e) => {
    if (e && e.message && CONN_FAIL.test(e.message) && !e.ofsConn) {
      e.ofsConn = true;
      e.message = e.message + ' [' + prefix.toLowerCase() + ' -> ' + describe(prefix) +
        '; the address comes from .env and is read only at startup, so a change to it ' +
        'needs a restart]';
    }
    throw e;
  };
  const query = async (sql, params) => get().query(sql, params || []).catch(named);
  return {
    prefix,
    label: () => describe(prefix),
    getPool: get,
    query,
    rows: async (sql, params) => (await query(sql, params)).rows,
    one: async (sql, params) => (await query(sql, params)).rows[0] || null,
    tx: async (fn) => {
      const c = await get().connect().catch(named);
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
