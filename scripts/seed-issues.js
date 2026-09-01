'use strict';
/**
 * Load a CSV of past/current issues into the master, then archive the ones whose
 * windows have closed. Used to seed the 2026 calendar (docs/seed/ofs_2026.csv).
 *
 *   npm run seed-issues                    # seed + archive the expired
 *   npm run seed-issues -- --file x.csv    # a different file
 *   npm run seed-issues -- --no-archive    # seed only
 *   npm run seed-issues -- --dry           # parse and report, write nothing
 *
 * Uses the same upsert as an exchange pull, so re-running it is safe: an issue that
 * already exists is matched on symbol + ISIN + T-day and only updated where a value
 * actually differs.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { upsertIssues } = require('../lib/issueSync');
const archiver = require('../lib/archiver');
const ofs = require('../db/ofsAdapter');

const args = process.argv.slice(2);
const has = (f) => args.indexOf(f) >= 0;
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const FILE = path.resolve(val('--file', path.join(__dirname, '..', 'docs', 'seed', 'ofs_2026.csv')));
const NUM = ['floor_price', 'cut_price_min', 'tick', 'lot', 'issue_qty', 'retail_qty', 'discount_pct'];
const REQUIRED = ['symbol', 'company', 'isin', 'floor_price', 'hni_open', 'hni_close', 'ret_open', 'ret_close'];

/** Small CSV reader: quoted fields, CRLF, and nothing else — this is our own file. */
function parseCsv(text) {
  const out = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = splitLine(lines.shift()).map((h) => h.trim().toLowerCase());
  for (const line of lines) {
    const cells = splitLine(line);
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    out.push(row);
  }
  return out;
}

function splitLine(line) {
  const cells = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

function toIssue(row) {
  const issue = { source: 'csv' };
  for (const k of Object.keys(row)) {
    let v = row[k];
    if (v === '') { issue[k] = null; continue; }
    issue[k] = NUM.indexOf(k) >= 0 ? Number(v) : v;
  }
  if (issue.cut_price_min == null) issue.cut_price_min = issue.floor_price;
  return issue;
}

async function main() {
  if (!fs.existsSync(FILE)) { console.error('No such file:', FILE); process.exit(1); }
  const rows = parseCsv(fs.readFileSync(FILE, 'utf8'));

  const issues = [], bad = [];
  for (const r of rows) {
    const missing = REQUIRED.filter((k) => !r[k]);
    if (missing.length) { bad.push({ symbol: r.symbol || '?', missing }); continue; }
    issues.push(toIssue(r));
  }

  console.log('Read ' + rows.length + ' row(s) from ' + path.basename(FILE) +
    ' — ' + issues.length + ' usable, ' + bad.length + ' skipped');
  for (const b of bad) console.warn('  skipped ' + b.symbol + ': missing ' + b.missing.join(', '));

  const pending = issues.filter((i) => !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(String(i.isin))).length;
  if (pending) {
    console.warn('  ' + pending + ' issue(s) carry a placeholder ISIN and cannot be exported');
    console.warn('  until a real one is entered under Masters -> Issues. This is deliberate.');
  }

  if (has('--dry')) { console.log('Dry run — nothing written.'); return; }

  const r = await upsertIssues(issues, 'seed-script');
  console.log('Issue master: ' + r.inserted + ' new, ' + r.updated + ' updated, ' + r.skipped + ' unchanged');

  if (!has('--no-archive')) {
    const a = await archiver.sweep({ actor: 'seed-script', days: 0,
      reason: 'seeded history: bidding window already closed' });
    console.log('Archived ' + a.archived.length + ' closed issue(s): ' +
      (a.archived.map((x) => x.symbol).join(', ') || '(none)'));
  }
}

main()
  .catch((e) => { console.error('seed failed:', e.message); process.exitCode = 1; })
  .finally(() => ofs.close().catch(() => {}));
