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

/**
 * Whether a client may bid, as ONE piece of SQL, written once.
 *
 * The account record in dwh.tbl_user_info is the authority and the only authority.
 * The client master is a branch mapping - it says which branch or authorised
 * partner a client belongs to - and it does not decide whether anybody may bid.
 * Two sources deciding one thing is how this went wrong before: each status fell
 * back to the other, so whichever one happened to be present answered for both,
 * and a client with no client-master row came out active.
 *
 * Expects the account record to be aliased "u". A blank status is not a yes.
 */
const CLIENT_ACTIVE_SQL = "lower(btrim(COALESCE(u.status, ''))) = 'active'";

module.exports = {
  DWH, STG, ADMIN, CLIENT_ACTIVE_SQL,
  label: conn.label,
  getPool: conn.getPool,
  query: conn.query,
  rows: conn.rows,
  one: conn.one,
  tx: conn.tx,
  close: conn.close
};
