'use strict';
/**
 * Connection smoke test — run BEFORE the first migrate, and after any env change.
 *   npm run smoke
 * Verifies both databases answer, that the OFS database is writable, and that the
 * LD tables really carry the columns REUSE.md claims. Reports; never modifies.
 */
require('dotenv').config();
const ofs = require('./ofsAdapter');
const ananta = require('./anantaAdapter');
const ld = require('./ldAdapter');
const { T } = require('./adminAdapter');

let bad = 0;
const ok   = (m, d) => console.log('  ok    ' + m + (d ? '  — ' + d : ''));
const warn = (m, d) => console.log('  warn  ' + m + (d ? '  — ' + d : ''));
const fail = (m, d) => { bad++; console.log('  FAIL  ' + m + (d ? '  — ' + d : '')); };

async function columnsOf(schema, table) {
  return (await ananta.rows(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`, [schema, table])).map((r) => r.column_name);
}

async function main() {
  console.log('\nOFS database   : ' + ofs.label());
  try {
    const r = await ofs.one('SELECT current_database() AS db, current_user AS usr, version() AS v');
    ok('connected', r.db + ' as ' + r.usr);
    ok('server', String(r.v).split(',')[0]);
    const canCreate = await ofs.one('SELECT has_database_privilege(current_user, current_database(), $1) AS y', ['CREATE']);
    (canCreate.y ? ok : fail)('CREATE privilege on the database', canCreate.y ? '' : 'migrate will fail');
    const sch = await ofs.one(
      'SELECT 1 AS y FROM information_schema.schemata WHERE schema_name = $1', [ofs.SCHEMA]);
    if (sch) {
      const tabs = await ofs.rows(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [ofs.SCHEMA]);
      ok('schema "' + ofs.SCHEMA + '" exists', tabs.length + ' table(s): ' + tabs.map((t) => t.table_name).join(', '));
    } else {
      warn('schema "' + ofs.SCHEMA + '" not created yet', 'run: npm run migrate');
    }
  } catch (e) { fail('connect', e.message); }

  console.log('\nAnanta database: ' + ananta.label());
  try {
    const r = await ananta.one('SELECT current_database() AS db, current_user AS usr');
    ok('connected', r.db + ' as ' + r.usr);

    // `need` is what ldAdapter's SELECT actually references; `optional` is used when
    // present but has a fallback. A missing column prints the real column list, so a
    // rename is diagnosed in one run instead of needing a second query.
    for (const [schema, table, need, optional] of [
      [ananta.DWH, 'tbl_user_info',
        ['ucc', 'pan', 'mobile', 'email', 'client_name', 'first_name', 'middle_name', 'last_name',
         'ucc_client_category', 'depository', 'dp_name', 'dp_account_no', 'status', 'poa', 'city', 'state'],
        ['name_asper_pan', 'etl_loaded_at']],
      [ananta.STG, 'ask_clientmast', ['ctermcode', 'branch_id', 'last_traded_date'], []]
    ]) {
      const cols = await columnsOf(schema, table);
      if (!cols.length) { fail(schema + '.' + table, 'not found or not visible to this user'); continue; }
      const missing = need.filter((c) => !cols.includes(c));
      if (missing.length) {
        fail(schema + '.' + table, 'missing column(s): ' + missing.join(', '));
        console.log('        actual columns: ' + cols.join(', '));
      } else {
        ok(schema + '.' + table, cols.length + ' columns, all required present');
      }
      const absent = (optional || []).filter((c) => !cols.includes(c));
      if (absent.length) warn(schema + '.' + table, 'optional column(s) absent, fallback used: ' + absent.join(', '));
    }

    const n = await ananta.one(`SELECT count(*)::bigint AS n FROM ${ananta.DWH}.tbl_user_info`);
    (Number(n.n) > 0 ? ok : warn)('client master row count', String(n.n));

    for (const t of ['users', 'roles', 'page_registry']) {
      try { await ananta.one(`SELECT 1 FROM ${T(t)} LIMIT 1`); ok('readable ' + T(t)); }
      catch (e) { fail('readable ' + T(t), e.message); }
    }
    try {
      const w = await ananta.one(
        `SELECT has_table_privilege(current_user, $1, 'INSERT') AS y`, [ananta.ADMIN + '.page_registry']);
      (w.y ? ok : fail)('INSERT on page_registry', w.y ? '' : 'ofs-desk / ofs-masters will not self-register');
    } catch (e) { warn('INSERT on page_registry', e.message); }
  } catch (e) { fail('connect', e.message); }

  console.log('\nLD lookup path (what the desk actually calls)');
  try {
    const sample = await ld.search('', 3);
    ok('ldAdapter.search', sample.length + ' row(s)');
    if (sample.length) {
      const c = sample[0];
      console.log('        sample ucc=' + c.ucc + ' name=' + (c.name ? 'resolved' : 'EMPTY') +
                  ' pan=' + String(c.pan || '').slice(0, 3) + '***' +
                  ' mobile=***' + String(c.mobile || '').slice(-4) +
                  ' category=' + (c.category || '-') + ' branch_id=' + (c.branch_id || '-'));
      const hit = await ld.findByUcc(c.ucc);
      (hit ? ok : fail)('ldAdapter.findByUcc round-trips');
      const many = await ld.findMany(sample.map((x) => x.ucc));
      (many.size === sample.length ? ok : warn)('ldAdapter.findMany', many.size + '/' + sample.length + ' resolved');
    } else {
      warn('no client rows', 'the desk will reject every bid with unknown_client');
    }
  } catch (e) { fail('ldAdapter', e.message); }

  console.log(bad ? '\n' + bad + ' check(s) FAILED\n' : '\nall checks passed\n');
  return bad;
}

main()
  .then(async (n) => { await ofs.close(); await ananta.close(); process.exit(n ? 1 : 0); })
  .catch(async (e) => { console.error('\nsmoke aborted:', e.message); await ofs.close(); await ananta.close(); process.exit(1); });
