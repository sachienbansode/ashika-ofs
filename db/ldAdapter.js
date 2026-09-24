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

/**
 * Column names verified against the live tables on 2026-09-01.
 *
 * dwh.tbl_user_info has NO `name`, `branch` or `category` (REUSE.md was wrong).
 * stg.ask_clientmast carries the richer client record - status, branch, category,
 * trading dates - so identity is assembled from both, preferring the DWH value and
 * falling back to the client master.
 *
 * DELIBERATELY NOT SELECTED: aadhar, annual_income, income, networth, gst_no.
 * An OFS bidding desk has no need for a client's income or net worth, and pulling
 * them into this app would put them in reach of every desk view and CSV export.
 */
const SELECT = `
  SELECT upper(btrim(u.ucc))                                             AS ucc,
         COALESCE(
           NULLIF(btrim(u.name_asper_pan), ''),
           NULLIF(btrim(c.name_asper_pan), ''),
           NULLIF(btrim(u.client_name), ''),
           NULLIF(btrim(c.cclientname), ''),
           btrim(concat_ws(' ', u.first_name, u.middle_name, u.last_name))
         )                                                               AS name,
         upper(btrim(u.pan))                                             AS pan,
         right(regexp_replace(
           COALESCE(NULLIF(btrim(u.mobile), ''), c.mobile, ''), '[^0-9]', '', 'g'), 10) AS mobile,
         lower(btrim(COALESCE(NULLIF(btrim(u.email), ''), c.email_id)))  AS email,
         u.depository, u.dp_name, u.dp_account_no,
         COALESCE(NULLIF(btrim(u.ucc_client_category), ''), c.client_category) AS category,
         c.branch_id,
         c.residential_status,
         COALESCE(NULLIF(btrim(u.city), ''), c.city)                     AS city,
         COALESCE(NULLIF(btrim(u.state), ''), c.state)                   AS state,
         u.status                                                        AS dwh_status,
         c.cstatus                                                       AS client_status,
         c.activation_status,
         c.last_traded_date,
         c.account_opened,
         u.etl_loaded_at,
         -- Eligibility for OFS bidding: the ACCOUNT RECORD decides, and only it.
         --
         -- The client master is a branch mapping. It says which branch or partner a
         -- client belongs to, and it is read here for that and for nothing else. It
         -- used to sit in this condition too, ANDed with the account status and
         -- COALESCEd into it, which let each source answer for the other - so a
         -- client with no client-master row came out active and could bid.
         --
         -- One source, no fallback, and a blank status is not a yes.
         (lower(btrim(COALESCE(u.status, ''))) = 'active')                              AS is_active,
         -- Why not, in words, so a screen can say more than "cannot bid".
         CASE WHEN NOT (lower(btrim(COALESCE(u.status, ''))) = 'active')
              THEN 'account status is ' || COALESCE(NULLIF(btrim(u.status), ''), 'blank')
              ELSE NULL
         END                                                             AS inactive_reason
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

/**
 * Desk search across UCC / name / PAN / mobile.
 *
 * Every field used to be matched with the same %term% - a substring, anywhere.
 * That is right for a name and for a UCC, and quietly wrong for the other two.
 *
 * A PAN is five letters, four digits, a letter, and the fifth character is the
 * first letter of the surname. So searching the UCC M9757 also matched the PAN of
 * every client called M-something whose four digits are 9757: the desk typed one
 * client's code and got a stranger back, with no way to see why, because PAN is
 * masked on that screen. It is also a quiet oracle - a PAN can be probed a
 * fragment at a time through a search box.
 *
 * The same went for the mobile: the digits inside a UCC or a PAN fragment would
 * match somebody's number in the middle.
 *
 * So each field is matched the way people actually search it:
 *   UCC and names   - contains, as before
 *   PAN             - from the start, so a full or leading PAN works and a
 *                     fragment buried in the middle of someone else's does not
 *   mobile          - only when the whole term is digits, so letters never reach it
 *
 * Both the page and the count have to filter identically or the pager claims a
 * number of rows the list cannot produce, so the clause is written once. $1 is the
 * contains term, $2 the prefix term, $3 the digits - empty when the term is not
 * all digits, which switches the mobile test off.
 */
const MATCH = `upper(btrim(u.ucc)) LIKE $1
            OR upper(COALESCE(u.client_name,'')) LIKE $1
            OR upper(COALESCE(u.name_asper_pan,'')) LIKE $1
            OR upper(COALESCE(c.cclientname,'')) LIKE $1
            OR upper(btrim(u.pan)) LIKE $2
            OR ($3 <> '' AND right(regexp_replace(
                 COALESCE(NULLIF(btrim(u.mobile),''), c.mobile, ''),'[^0-9]','','g'),10) LIKE '%' || $3)`;

/** The three search terms MATCH expects, derived from what was typed. */
function searchTerms(term) {
  const t = norm(term);
  return [
    '%' + t + '%',                     // $1 contains - UCC and names
    t + '%',                           // $2 prefix   - PAN
    /^[0-9]{4,}$/.test(t) ? t : ''     // $3 digits   - mobile, or switched off
  ];
}

/**
 * The status buckets the desk filters by.
 *
 * Every client falls in exactly ONE of them: the four named statuses, and 'other'
 * for everything else — which includes the blank status, because a client with no
 * status recorded is precisely the row somebody needs to be able to go and look
 * at, and a filter that can reach every row except those is a filter with a blind
 * spot. 'all' and anything unrecognised filter nothing, so a stale bookmark or a
 * hand-typed query string widens the list rather than emptying it.
 */
const STATUS_BUCKETS = ['active', 'dormant', 'closed', 'inactive'];

const STATUS_COL = "lower(btrim(COALESCE(u.status, '')))";

/** { sql, param } for one bucket, or null when nothing should be narrowed. */
function statusClause(status, at) {
  const s = String(status || '').trim().toLowerCase();
  if (!s || s === 'all') return null;
  if (s === 'other') return { sql: STATUS_COL + ' <> ALL($' + at + '::text[])', param: STATUS_BUCKETS };
  if (STATUS_BUCKETS.indexOf(s) < 0) return null;
  return { sql: STATUS_COL + ' = $' + at, param: s };
}

const FROM = `FROM ${DWH}.tbl_user_info u
              LEFT JOIN ${STG}.ask_clientmast c
                ON upper(btrim(c.ctermcode)) = upper(btrim(u.ucc))`;

/**
 * One page of clients, and how many there are in total.
 *
 * Paged in SQL, not in the app. The desk's client base runs to tens of thousands;
 * the previous version took a `limit` and returned that many rows with no offset
 * and no total, so the screen could only ever show the first N and the desk had no
 * way to reach the rest except by typing a narrower search.
 *
 * The count is a second query rather than a window function: `count(*) OVER ()`
 * would be free per row but still makes Postgres walk every matching row before
 * returning the first page, and on an unfiltered list that is the whole table.
 */
/**
 * One page of clients, and how many there are in total.
 *
 * The search term and the status filter are two independent narrowings and the
 * WHERE is built from whichever are present, rather than the two hard-coded
 * shapes this used to have. The status filter in particular HAS to be applied
 * here: the desk's book is a hundred and thirty thousand clients paged ten at a
 * time, so a filter applied in the browser would narrow the ten rows on screen
 * and silently claim there were no dormant clients past page one.
 *
 * The page and the count are built from the same clause and the same parameters,
 * or the pager promises a number of rows the list cannot produce.
 */
async function searchPage(q, limit, offset, status) {
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const term = String(q || '').trim();

  /* MATCH is written against $1 $2 $3, so the search terms go in first and
   * everything after them is numbered from wherever they left off. */
  const where = [], params = [];
  if (term) {
    const t = searchTerms(term);
    params.push(t[0], t[1], t[2]);
    where.push('(' + MATCH + ')');
  }
  const st = statusClause(status, params.length + 1);
  if (st) { params.push(st.param); where.push(st.sql); }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';

  /* An exact UCC first, then the ones that start with what was typed, then the
   * rest. Typing a whole client code and finding it third is its own small
   * failure, even when every row in the list does match it somehow. */
  const pageParams = params.slice();
  let order = ' ORDER BY u.ucc';
  if (term) {
    pageParams.push(norm(term));
    order = ' ORDER BY (upper(btrim(u.ucc)) = $' + pageParams.length + ') DESC,' +
            ' (upper(btrim(u.ucc)) LIKE $2) DESC, u.ucc';
  }
  pageParams.push(lim, off);
  const nL = pageParams.length - 1, nO = pageParams.length;

  const [list, n] = await Promise.all([
    ananta.rows(SELECT + clause + order + ' LIMIT $' + nL + ' OFFSET $' + nO, pageParams),
    ananta.one('SELECT count(*)::int AS n ' + FROM + clause, params)
  ]);
  return {
    clients: list, total: (n && n.n) || 0, limit: lim, offset: off,
    // Echoed back so the screen can show what it is actually looking at, and so a
    // value the server ignored does not leave the dropdown claiming otherwise.
    status: st ? String(status).trim().toLowerCase() : null
  };
}

/** The old shape, still used where a plain list is wanted (the bid form's lookup). */
async function search(q, limit) {
  const r = await searchPage(q, limit == null ? 50 : limit, 0);
  return r.clients;
}

async function exists(ucc) {
  if (!norm(ucc)) return false;
  const r = await ananta.one(
    `SELECT 1 AS ok FROM ${DWH}.tbl_user_info WHERE upper(btrim(ucc)) = $1 LIMIT 1`, [norm(ucc)]);
  return !!r;
}

/** Identity + eligibility in one round trip, for the bid path. */
async function eligibility(ucc) {
  const c = await findByUcc(ucc);
  if (!c) return { found: false, active: false, client: null };
  return { found: true, active: c.is_active === true, reason: c.inactive_reason || null, client: c };
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
      // c.branch has never existed on the SELECT above — the column is branch_id —
      // so this was quietly null on every enriched row, which is why the bid book
      // had no branch to show.
      branch: c ? c.branch_id : null,
      branch_id: c ? c.branch_id : null,
      client_active: c ? c.is_active === true : null
    });
  });
}

module.exports = { norm, findByUcc, findMany, search, searchPage, exists, eligibility, enrich,
  STATUS_BUCKETS, statusClause };
