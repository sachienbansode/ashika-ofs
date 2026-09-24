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

/**
 * Whether a client may be SEEN, which is a different question.
 *
 * A dormant account is one of the branch's clients - it is on their book, it has a
 * margin, it has a history - it simply cannot bid today. Scoping the branch's list
 * to active only meant a dormant client vanished from the screen entirely, and
 * typing their code answered "That UCC is not one of your clients", which is not
 * true and sends the AP to the wrong person to fix it.
 *
 * So the list is active AND dormant, and every write still asks CLIENT_ACTIVE_SQL
 * (through ldAdapter.eligibility) before a bid is allowed. Seen is not the same as
 * allowed, and the two are separate strings here so they cannot be confused.
 *
 * Anything else - closed, suspended, blank - stays out of both.
 */
const CLIENT_VISIBLE_SQL = "lower(btrim(COALESCE(u.status, ''))) IN ('active', 'dormant')";

module.exports = {
  DWH, STG, ADMIN, CLIENT_ACTIVE_SQL, CLIENT_VISIBLE_SQL,
  label: conn.label,
  getPool: conn.getPool,
  query: conn.query,
  rows: conn.rows,
  one: conn.one,
  tx: conn.tx,
  close: conn.close
};
