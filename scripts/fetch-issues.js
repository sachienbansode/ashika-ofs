'use strict';
/**
 * Discover and import the OFS issue master from an exchange.
 *
 *   npm run fetch-issues                 both exchanges, report only, no writes
 *   npm run fetch-issues -- --source BSE
 *   npm run fetch-issues -- --apply      write what was found into ofs.ofs_issue
 *   npm run fetch-issues -- --raw        dump what each endpoint returned
 *
 * Run this ON THE SERVER: exchange sites are reachable from there, and the report
 * shows exactly which endpoint answered and what fields it used, which is what the
 * parser has to be matched against.
 */
require('dotenv').config();
const { sourceFor } = require('../lib/issueSource');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const APPLY = has('--apply');
const RAW = has('--raw');
const WANT = (val('--source', 'BSE,NSE') || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);

async function run(exchange) {
  console.log('\n=== ' + exchange + ' ===');
  const src = sourceFor(exchange);
  const out = await src.fetchIssues();

  for (const a of out.attempts) {
    const bits = [String(a.status).padStart(3), a.url];
    if (a.note) bits.push('(' + a.note + ')');
    if (a.contentType) bits.push(a.contentType);
    if (a.bytes) bits.push(a.bytes + 'b');
    if (a.rows != null) bits.push(a.rows + ' rows');
    if (a.cookies != null) bits.push(a.cookies + ' cookies');
    if (a.error) bits.push('ERROR ' + a.error);
    console.log('  ' + bits.join('  '));
    if (a.sampleKeys && a.sampleKeys.length) console.log('      fields: ' + a.sampleKeys.join(', '));
    if (RAW && a.bodyHead) console.log('      body: ' + JSON.stringify(a.bodyHead.slice(0, 300)));
    if (RAW && a.sample) console.log('      sample: ' + JSON.stringify(a.sample).slice(0, 600));
  }

  if (!out.source) {
    console.log('  -> no endpoint returned usable rows.');
    console.log('     Re-run with --raw and send the output; the parser is matched to what comes back.');
    return { found: 0, applied: 0 };
  }

  console.log('  -> ' + out.issues.length + ' usable issue(s) from ' + out.source);
  for (const i of out.issues) {
    console.log('     ' + i.symbol.padEnd(12) + ' floor ' + String(i.floor_price).padStart(9) +
                '  ' + String(i.hni_open).slice(0, 16) + ' → ' + String(i.ret_close).slice(0, 16));
  }
  if (out.rejected.length) {
    console.log('  -> ' + out.rejected.length + ' row(s) skipped:');
    const why = {};
    for (const r of out.rejected) why[r.reason] = (why[r.reason] || 0) + 1;
    for (const k of Object.keys(why)) console.log('     ' + why[k] + ' × ' + k);
    if (RAW && out.rejected[0]) console.log('     first: ' + JSON.stringify(out.rejected[0].raw).slice(0, 500));
  }

  if (!APPLY) { console.log('  (report only — pass --apply to write these to ofs_issue)'); return { found: out.issues.length, applied: 0 }; }

  const { upsertIssues } = require('../lib/issueSync');
  const r = await upsertIssues(out.issues, 'cli');
  console.log('  -> written: ' + r.inserted + ' new, ' + r.updated + ' updated, ' + r.skipped + ' unchanged');
  return { found: out.issues.length, applied: r.inserted + r.updated };
}

(async () => {
  let total = 0;
  for (const ex of WANT) {
    try { total += (await run(ex)).found; }
    catch (e) { console.error('  ' + ex + ' failed: ' + e.message); }
  }
  console.log('\n' + total + ' issue(s) found across ' + WANT.join(', ') + '\n');
  const { close } = require('../db/ofsAdapter');
  await close().catch(() => {});
  process.exit(0);
})();
