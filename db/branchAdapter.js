'use strict';
/**
 * Branches and Authorised Partners, read from LD.
 *
 * stg.branchho is the branch master (Oracle LDBO.BRANCHHO, mirrored by the ETL —
 * every column arrives as TEXT and Oracle CHAR padding comes with it, so btrim is
 * not optional anywhere below). A branch's clients are the rows of
 * stg.ask_clientmast whose BRANCH_ID equals its BRANCHCODE.
 *
 * Who may sign in, as agreed with Ashika:
 *   FIRMNUMBER = 'ASK-000001'   — one firm only
 *   ACTIVE     = 'Y'            — LD's own flag, never overridden upwards
 *   and not disabled in ofs.ofs_branch_setting, which is the desk's own override:
 *   it can take login away from an active branch, and can never grant it to an
 *   inactive one. A permission table that can only subtract is a lot easier to
 *   reason about at an audit than one that can add.
 *
 * EMAIL in this table is free text. Real values look like 'ops@ashikagroup.com;'
 * and sometimes hold two addresses, so it is split on ; and , before matching —
 * matching the raw column would have failed on the trailing semicolon that most
 * rows carry.
 */
const ananta = require('./anantaAdapter');
const { SCHEMA, rows: ofsRows } = require('./ofsAdapter');

const STG = ananta.STG;

/** The only firm whose branches may sign in. Settable, but not by accident. */
const FIRM = () => String(process.env.OFS_BRANCH_FIRM || 'ASK-000001').trim();

const normEmail = (v) => String(v || '').trim().toLowerCase();
const normCode = (v) => String(v || '').trim().toUpperCase();

const BRANCH_COLS = `
  upper(btrim(b.branchcode))                        AS branch_code,
  btrim(b.branchname)                               AS branch_name,
  btrim(b.firmnumber)                               AS firm,
  upper(btrim(COALESCE(b.branchtype,'')))           AS branch_type,
  upper(btrim(COALESCE(b.active,'')))               AS active_flag,
  btrim(COALESCE(b.email,''))                       AS email_raw,
  right(regexp_replace(COALESCE(b.cmobileno,''), '[^0-9]', '', 'g'), 10) AS mobile,
  btrim(COALESCE(b.contactperson,''))               AS contact_person,
  btrim(COALESCE(b.ccity,''))                       AS city,
  btrim(COALESCE(b.cstate,''))                      AS state`;

/**
 * Every address in a branchho EMAIL cell, cleaned. Exported because the sign-in
 * screen and the audit trail both need to say which address a code went to.
 */
function emailsOf(raw) {
  return String(raw || '')
    .split(/[;,]/)
    .map((e) => normEmail(e))
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

/**
 * Branches that hold this email address, active and in the right firm.
 *
 * More than one is normal — a regional manager's address can appear against
 * several branchcodes — so this returns a list and the caller asks which.
 */
async function findByEmail(email) {
  const e = normEmail(email);
  if (!e) return [];
  return ananta.rows(
    `SELECT ${BRANCH_COLS}
       FROM ${STG}.branchho b
      WHERE btrim(b.firmnumber) = $2
        AND upper(btrim(COALESCE(b.active,''))) = 'Y'
        AND EXISTS (
              SELECT 1 FROM regexp_split_to_table(COALESCE(b.email,''), '[;,]') AS addr
               WHERE lower(btrim(addr)) = $1)
      ORDER BY upper(btrim(b.branchcode))`, [e, FIRM()]);
}

/** One branch by code — still subject to firm and ACTIVE. */
async function findByCode(code) {
  const c = normCode(code);
  if (!c) return null;
  return ananta.one(
    `SELECT ${BRANCH_COLS}
       FROM ${STG}.branchho b
      WHERE upper(btrim(b.branchcode)) = $1
        AND btrim(b.firmnumber) = $2
        AND upper(btrim(COALESCE(b.active,''))) = 'Y'
      LIMIT 1`, [c, FIRM()]);
}

/** Every active branch of the firm, for the desk's access screen. */
async function listAll() {
  return ananta.rows(
    `SELECT ${BRANCH_COLS}
       FROM ${STG}.branchho b
      WHERE btrim(b.firmnumber) = $1
        AND upper(btrim(COALESCE(b.active,''))) = 'Y'
      ORDER BY upper(btrim(COALESCE(b.branchtype,''))), upper(btrim(b.branchcode))`, [FIRM()]);
}

/**
 * The UCCs a branch may act for: active clients whose BRANCH_ID is this branch.
 * Returned as bare codes — identity comes from ldAdapter, which already knows how
 * to assemble a client from both tables and what not to select.
 */
async function uccsOfBranch(code) {
  const c = normCode(code);
  if (!c) return [];
  const r = await ananta.rows(
    `SELECT upper(btrim(c.ctermcode)) AS ucc
       FROM ${STG}.ask_clientmast c
      WHERE upper(btrim(COALESCE(c.branch_id,''))) = $1
        AND lower(btrim(COALESCE(c.cstatus,''))) = 'active'
        AND upper(btrim(COALESCE(c.activation_status,'Y'))) = 'Y'
        AND btrim(COALESCE(c.ctermcode,'')) <> ''
      ORDER BY 1`, [c]);
  return r.map((x) => x.ucc);
}

/** Does this branch hold this client? The check every branch-scoped write makes. */
async function branchHasClient(code, ucc) {
  const c = normCode(code), u = normCode(ucc);
  if (!c || !u) return false;
  const r = await ananta.one(
    `SELECT 1 AS ok
       FROM ${STG}.ask_clientmast c
      WHERE upper(btrim(COALESCE(c.branch_id,''))) = $1
        AND upper(btrim(COALESCE(c.ctermcode,''))) = $2
        AND lower(btrim(COALESCE(c.cstatus,''))) = 'active'
        AND upper(btrim(COALESCE(c.activation_status,'Y'))) = 'Y'
      LIMIT 1`, [c, u]);
  return !!r;
}

/** Branch code per UCC, for the bid book. One round trip, not one per row. */
async function branchOfUccs(uccs) {
  const list = Array.from(new Set((uccs || []).map(normCode).filter(Boolean)));
  const map = new Map();
  if (!list.length) return map;
  const r = await ananta.rows(
    `SELECT upper(btrim(c.ctermcode)) AS ucc, upper(btrim(COALESCE(c.branch_id,''))) AS branch_code
       FROM ${STG}.ask_clientmast c
      WHERE upper(btrim(c.ctermcode)) = ANY($1)`, [list]);
  for (const x of r) map.set(x.ucc, x.branch_code || null);
  return map;
}

/**
 * The desk's override, from the OFS database. Only ever takes login away.
 * Returns a Set of branch codes that may NOT sign in.
 */
async function blockedCodes() {
  const r = await ofsRows(
    `SELECT branch_code FROM ${SCHEMA}.ofs_branch_setting WHERE login_enabled = false`);
  return new Set(r.map((x) => normCode(x.branch_code)));
}

module.exports = {
  FIRM, emailsOf, normEmail, normCode,
  findByEmail, findByCode, listAll,
  uccsOfBranch, branchHasClient, branchOfUccs, blockedCodes
};
