'use strict';
/**
 * Generate the test plan workbook.
 *
 * A template rather than a blank file: every column is there with an example in
 * it and a note saying what it is for, because a sheet headed `otp_mode` with
 * nothing under it is a question, not an instruction.
 *
 *   node scripts/make-plan.js                  -> plan/OFS_Test_Plan_TEMPLATE.xlsx
 *   node scripts/make-plan.js plan/mine.xlsx   -> somewhere else
 *
 * Fill it in, save it OUTSIDE the repo, and pass it with --book. It will hold
 * live passwords; .gitignore keeps the filled-in copy out, but a file that never
 * enters the working tree is safer than one that relies on a rule.
 */
const path = require('path');
const ExcelJS = require('exceljs');

const OUT = process.argv[2] ||
  path.join(__dirname, '..', 'plan', 'OFS_Test_Plan_TEMPLATE.xlsx');

const HEAD = { bold: true, color: { argb: 'FFFFFFFF' } };
const FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };

function sheet(wb, name, cols, rows, note) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.h, key: c.k, width: c.w || 24 }));
  const h = ws.getRow(1);
  h.font = HEAD; h.fill = FILL; h.alignment = { vertical: 'middle' };
  h.height = 20;
  rows.forEach((r) => ws.addRow(r));
  if (note) {
    ws.addRow([]);
    const n = ws.addRow([note]);
    n.font = { italic: true, color: { argb: 'FF666666' }, size: 10 };
    ws.mergeCells(n.number, 1, n.number, Math.max(2, cols.length));
    ws.getRow(n.number).alignment = { wrapText: true, vertical: 'top' };
    ws.getRow(n.number).height = 46;
  }
  return ws;
}

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ashika OFS QA';
  wb.created = new Date();

  sheet(wb, 'Environment',
    [{ h: 'name', k: 'name', w: 12 },
     { h: 'base_url', k: 'base_url', w: 44 },
     { h: 'writes_allowed', k: 'writes_allowed', w: 16 },
     { h: 'otp_wait_seconds', k: 'otp_wait_seconds', w: 18 },
     { h: 'notes', k: 'notes', w: 52 }],
    [{ name: 'UAT', base_url: 'https://uat-ofs-bids.ashikagroup.com', writes_allowed: 'yes',
       otp_wait_seconds: 180, notes: 'Full suite. Safe to create issues, bids and margins.' },
     { name: 'PROD', base_url: 'https://ofs-bids.ashikagroup.com', writes_allowed: 'no',
       otp_wait_seconds: 180,
       notes: 'Set writes_allowed=yes only for an attended run outside market hours. Every bid placed is withdrawn in teardown.' }],
    'ONE base_url per environment — the three shells (/backoffice, /partner, /) are derived from it, '
    + 'because they are fixed mount points in server.js. Pick the row with --env=UAT or --env=PROD. '
    + 'writes_allowed gates every spec that changes anything; render tests ignore it and always run.');

  sheet(wb, 'Users',
    [{ h: 'role', k: 'role', w: 12 },
     { h: 'label', k: 'label', w: 22 },
     { h: 'identifier', k: 'identifier', w: 34 },
     { h: 'password', k: 'password', w: 22 },
     { h: 'branch_code', k: 'branch_code', w: 14 },
     { h: 'otp_mode', k: 'otp_mode', w: 12 },
     { h: 'static_otp', k: 'static_otp', w: 12 },
     { h: 'notes', k: 'notes', w: 46 }],
    [{ role: 'desk', label: 'Back-office admin', identifier: 'someone@ashikagroup.com',
       password: '', branch_code: '', otp_mode: 'none', static_otp: '',
       notes: 'Back-office sign-in is email + password. No OTP on this door.' },
     { role: 'ap', label: 'Authorised Partner', identifier: 'branch.mailbox@ashikagroup.com',
       password: '', branch_code: 'A016', otp_mode: 'manual', static_otp: '',
       notes: 'branch_code is only needed when the address is registered against more than one.' },
     { role: 'client', label: 'Test investor', identifier: 'ASH1001',
       password: '', branch_code: '', otp_mode: 'manual', static_otp: '',
       notes: 'Client code, registered mobile or registered email — whichever you want tested.' }],
    'otp_mode: "none" for the desk, "manual" to pause and let you type the code into the visible '
    + 'browser, "static" once the admin allow-list exists in the app (then put the code in static_otp). '
    + 'Passwords live here only because this file stays outside the repo — keep it off email and out of git.');

  sheet(wb, 'TestData',
    [{ h: 'key', k: 'key', w: 26 },
     { h: 'value', k: 'value', w: 30 },
     { h: 'notes', k: 'notes', w: 60 }],
    [{ key: 'issue_prefix', value: 'ZZQA',
       notes: 'Every issue the suite creates is named with this prefix, so they are identifiable and removable.' },
     { key: 'margin_uccs', value: 'ASH1001',
       notes: 'Comma separated. Margin is only ever written for these, and restored afterwards.' },
     { key: 'bid_ucc', value: 'ASH1001',
       notes: 'The client a desk-placed test bid is for. Must be active, and must be one you own.' },
     { key: 'search_ucc', value: 'ASH1001',
       notes: 'A UCC the read-only tests search for. Nothing is written against it.' },
     { key: 'search_name', value: 'ACTIVE',
       notes: 'Part of a client name the search should find.' }],
    'Read-only tests use search_ucc and search_name and touch nothing. The other keys are only '
    + 'consulted by write flows, which need writes_allowed=yes on the Environment row.');

  await wb.xlsx.writeFile(OUT);
  console.log('Wrote ' + OUT);
  console.log('Fill it in, save it outside the repo, then:');
  console.log('  npx playwright test --book="C:\\\\path\\\\to\\\\OFS_Test_Plan.xlsx" --env=UAT');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
