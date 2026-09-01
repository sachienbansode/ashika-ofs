'use strict';
/**
 * LD client lookups. This is what `ofs.ofs_client` used to be — it stopped being a
 * VIEW the moment OFS moved into its own database, because Postgres cannot join
 * across databases. Same contract as before (read-through to LD, never a copy),
 * but the join happens in the app: fetch OFS rows from ofs_bids, collect the UCCs,
 * fetch those clients here, merge.
 *
 * Identity convention (REUSE.md 1.2): ucc as upper(btrim(...)), phone as the
 * last 10 digits.
 */
const ananta = require('./anantaAdapter');

const DWH = ananta.DWH;
const STG = ananta.STG;

const SELECT = `
  SELECT upper(btrim(u.ucc))                                             AS ucc,
         COALESCE(NULLIF(btrim(u.name_asper_pan), ''), btrim(u.name))    AS name,
         upper(btrim(u.pan))                                             AS pan,
         right(regexp_replace(COALESCE(u.mobile,''), '[^0-9]', '', 'g'), 10) AS mobile,
         lower(btrim(u.email))                                           AS email,
         u.depository, u.dp_name, u.branch, u.category,
         c.branch_id, c.last_traded_date, u.etl_loaded_at
    FROM ${DWH}.tbl_user_info u
    LEFT JOIN ${STG}.ask_clientmast c
      ON upper(btrim(c.ctermcode)) = upper(btrim(u.ucc))`;

const norm = (v) => String(v || '').trim().toUpperCase();

/** One client, or null. */
async function findByUcc(ucc) {
  if (!norm(ucc)) return null;
  return ananta.one(SELECT + ` WHERE upper(btrim(u.ucc)) = $1 LIMIT 1`, [norm(ucc)]);
}

/** Many clients in one round trip. Returns a Map keyed by normalised UCC. */
async function findMany(uccs) {
  const list = Array.from(new Set((uccs || []).map(norm).filter(Boolean)));
  const map = new Map();
  if (!list.length) return map;
  const rows = await ananta.rows(SELECT + ` WHERE upper(btrim(u.ucc)) = ANY($1)`, [list]);
  for (const r of rows) map.set(r.ucc, r);
  return map;
}

/** Desk search across UCC / name / PAN / mobile. */
async function search(q, limit) {
  const lim = Math.min(Number(limit) || 50, 500);
  if (!String(q || '').trim()) return ananta.rows(SELECT + ` ORDER BY u.ucc LIMIT $1`, [lim]);
  const like = '%' + norm(q) + '%';
  return ananta.rows(
    SELECT + ` WHERE upper(btrim(u.ucc)) LIKE $1
                  OR upper(u.name) LIKE $1
                  OR upper(COALESCE(u.name_asper_pan,'')) LIKE $1
                  OR upper(btrim(u.pan)) LIKE $1
                  OR right(regexp_replace(COALESCE(u.mobile,''),'[^0-9]','','g'),10) LIKE $1
               ORDER BY u.ucc LIMIT $2`, [like, lim]);
}

async function exists(ucc) {
  if (!norm(ucc)) return false;
  const r = await ananta.one(
    `SELECT 1 AS ok FROM ${DWH}.tbl_user_info WHERE upper(btrim(ucc)) = $1 LIMIT 1`, [norm(ucc)]);
  return !!r;
}

/** Merge LD fields onto OFS rows by UCC. Rows keep every OFS column they arrived with. */
async function enrich(rows, uccField, into) {
  const key = uccField || 'client_ucc';
  const map = await findMany((rows || []).map((r) => r[key]));
  return (rows || []).map((r) => {
    const c = map.get(norm(r[key])) || null;
    if (into) return Object.assign({}, r, { [into]: c });
    return Object.assign({}, r, {
      client_name: c ? c.name : null,
      pan: c ? c.pan : null,
      mobile: c ? c.mobile : null,
      email: c ? c.email : null,
      branch: c ? c.branch : null
    });
  });
}

module.exports = { norm, findByUcc, findMany, search, exists, enrich };
