'use strict';
/**
 * The test plan workbook, read.
 *
 * The workbook is the suite's INPUT as well as its output: it carries the URLs,
 * the three sets of credentials and the designated test data, so nothing about a
 * particular environment is compiled into a spec. That is what lets the same
 * suite point at UAT and at production without a code change, and it is why the
 * filled-in copy never goes in the repo — it holds live passwords.
 *
 * Read once per run and cached: a spec that re-read it per test would take a
 * different view of the world half way through a run if somebody had the file
 * open in Excel.
 */
const path = require('path');
const fs = require('fs');

let cache = null;

/** Where the workbook is. --book wins, then the env var, then the template. */
function bookPath() {
  const arg = process.argv.find((a) => a.startsWith('--book='));
  const p = (arg && arg.slice(7)) ||
            process.env.OFS_QA_BOOK ||
            path.join(__dirname, '..', 'plan', 'OFS_Test_Plan.xlsx');
  return path.resolve(p);
}

/** Rows of a sheet as objects, keyed by the header row, lower_snake_cased. */
function rowsOf(ws) {
  if (!ws) return [];
  const head = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, n) => {
    head[n] = String(c.value == null ? '' : c.value).trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  });
  /* Stop at the first blank row, rather than taking every row with anything in
   * it. The sheets carry a note under the data explaining what the columns are
   * for, and a note read as a record put a user called "otp_mode: none for the
   * desk..." into the run. A blank line is what a person already means by the
   * end of a table. */
  const out = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const o = {};
    let any = false;
    row.eachCell({ includeEmpty: true }, (c, n) => {
      if (!head[n]) return;
      let v = c.value;
      // A cell Excel has turned into a hyperlink object, or a formula result.
      if (v && typeof v === 'object') v = v.text || v.result || v.hyperlink || '';
      v = v == null ? '' : String(v).trim();
      o[head[n]] = v;
      if (v) any = true;
    });
    if (!any) break;
    out.push(o);
  }
  return out;
}

async function load() {
  if (cache) return cache;
  const ExcelJS = require('exceljs');
  const file = bookPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      'No test plan workbook at ' + file + '\n' +
      'Run "npm run make-plan" to generate a template, fill it in, then pass it with\n' +
      '  npx playwright test --book="C:\\path\\to\\OFS_Test_Plan.xlsx"');
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const envName = (process.argv.find((a) => a.startsWith('--env=')) || '').slice(6) ||
                  process.env.OFS_QA_ENV || 'UAT';

  const envs = rowsOf(wb.getWorksheet('Environment'));
  const env = envs.find((e) => (e.name || '').toUpperCase() === envName.toUpperCase());
  if (!env) {
    throw new Error('No row named "' + envName + '" on the Environment sheet. Found: ' +
      (envs.map((e) => e.name).join(', ') || '(none)'));
  }
  if (!env.base_url) throw new Error('Environment "' + envName + '" has no base_url.');

  const users = rowsOf(wb.getWorksheet('Users'));
  const data = rowsOf(wb.getWorksheet('TestData'));

  const base = String(env.base_url).replace(/\/+$/, '');
  cache = {
    file, envName: env.name,
    env: Object.assign({}, env, {
      base_url: base,
      // The three shells are fixed mount points in server.js, so they are derived
      // rather than typed three times and mistyped once.
      backoffice_url: base + '/backoffice/',
      partner_url: base + '/partner/',
      client_url: base + '/',
      // Anything that writes is off unless the sheet says otherwise, in words.
      writes: /^(y|yes|true|1)$/i.test(String(env.writes_allowed || '')),
      otp_wait_ms: Number(env.otp_wait_seconds || 180) * 1000
    }),
    users, data,
    /** The first user of a role, or null. */
    user(role) {
      return users.find((u) => (u.role || '').toLowerCase() === String(role).toLowerCase()) || null;
    },
    /** A value from the TestData sheet by key. */
    value(key) {
      const r = data.find((d) => (d.key || '').toLowerCase() === String(key).toLowerCase());
      return r ? r.value : '';
    }
  };
  return cache;
}

module.exports = { load, bookPath, rowsOf };
