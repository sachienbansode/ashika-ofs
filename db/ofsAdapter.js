'use strict';
/**
 * ofsAdapter - mirrors db/codifiAdapter.js from omnenest-uploader-api (REUSE.md 1.1).
 * One pg.Pool for the Ananta instance; a fixed SCHEMA constant for OFS-owned tables.
 * The same pool also reads dwh/stg (LD data) - they live on this instance by design.
 */
const { Pool } = require('pg');

const SCHEMA = process.env.OFS_SCHEMA || 'ofs';
const DWH = process.env.DWH_SCHEMA || 'dwh';
const STG = process.env.STG_SCHEMA || 'stg';

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    // password read from PGPASSWORD by libpq convention - never inline it in a DSN
    password: process.env.PGPASSWORD || process.env.PG_PASSWORD,
    ssl: String(process.env.PG_SSL) === 'true' ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    application_name: 'ashika-ofs-app'
  });
  pool.on('error', (e) => console.error('[ofsAdapter] idle client error:', e.message));
  return pool;
}

async function query(sql, params) {
  const res = await getPool().query(sql, params || []);
  return res;
}

async function rows(sql, params) {
  return (await query(sql, params)).rows;
}

async function one(sql, params) {
  return (await query(sql, params)).rows[0] || null;
}

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function close() { if (pool) { await pool.end(); pool = null; } }

module.exports = { SCHEMA, DWH, STG, getPool, query, rows, one, tx, close };
