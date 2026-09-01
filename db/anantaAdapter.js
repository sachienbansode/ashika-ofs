'use strict';
/**
 * The platform's Ananta database (`uat_ananta_staging` — despite the name this is
 * PRODUCTION). Holds LD/DWH client data and the "admin-staging-api" meta schema
 * (users, roles, page_registry). The OFS app READS LD here and writes only its
 * own page-registry entries.
 */
const { make } = require('./pool');

const DWH = process.env.DWH_SCHEMA || 'dwh';
const STG = process.env.STG_SCHEMA || 'stg';
const ADMIN = process.env.ADMIN_SCHEMA || 'admin-staging-api';
const conn = make('ANANTA', 'ashika-ofs-app');

module.exports = {
  DWH, STG, ADMIN,
  label: conn.label,
  getPool: conn.getPool,
  query: conn.query,
  rows: conn.rows,
  one: conn.one,
  tx: conn.tx,
  close: conn.close
};
