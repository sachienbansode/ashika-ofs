'use strict';
/**
 * OFS-owned state. Its own database (`ofs_bids`) on the prod box, with the OFS
 * tables under the `ofs` schema inside it.
 *
 * This pool CANNOT see dwh/stg/"admin-staging-api" — those live in a different
 * database. Use anantaAdapter / ldAdapter for those and merge in the app.
 */
const { make } = require('./pool');

const SCHEMA = process.env.OFS_SCHEMA || 'ofs';
const conn = make('OFS', 'ashika-ofs-app');

module.exports = {
  SCHEMA,
  label: conn.label,
  getPool: conn.getPool,
  query: conn.query,
  rows: conn.rows,
  one: conn.one,
  tx: conn.tx,
  close: conn.close
};
