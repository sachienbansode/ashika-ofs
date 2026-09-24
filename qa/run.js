'use strict';
/**
 * The front door.
 *
 *   npm test -- --book "C:\Ashika\OFS_Test_Plan.xlsx" --env PROD
 *   npm test -- --book ...\plan.xlsx --env UAT --only desk
 *
 * Playwright's own CLI refuses arguments it does not recognise, so --book and
 * --env are turned into environment variables here and everything else is passed
 * straight through. That keeps one command for the whole suite rather than
 * asking anybody to remember which flags belong to which tool, and it works the
 * same in PowerShell as in bash.
 *
 * The workbook is validated before a browser starts. A missing plan, a missing
 * environment row or a desk user with no password should cost a second and a
 * clear sentence, not forty tests timing out against `undefined/backoffice/`.
 */
const { spawn } = require('child_process');
const path = require('path');

const argv = process.argv.slice(2);
const pass = [];
let book = process.env.OFS_QA_BOOK || '';
let env = process.env.OFS_QA_ENV || '';
let only = '';

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
  if (a === '--book' || a.startsWith('--book=')) book = take();
  else if (a === '--env' || a.startsWith('--env=')) env = take();
  else if (a === '--only' || a.startsWith('--only=')) only = take();
  else pass.push(a);
}

if (book) process.env.OFS_QA_BOOK = path.resolve(book);
if (env) process.env.OFS_QA_ENV = env;

/* Read it now, so the failure is here and readable. */
let plan;
try {
  plan = require('./lib/bookSync').loadSync();
} catch (e) {
  console.error(String(e.message || e).trim());
  console.error('\nNo plan yet?  npm run make-plan   then fill it in and pass it with --book.\n');
  process.exit(2);
}

const writes = plan.env.writes;
console.log('Plan        ' + plan.file);
console.log('Environment ' + plan.envName + '  ' + plan.env.base_url);
console.log('Writes      ' + (writes ? 'ALLOWED — flows that change data will run' : 'off — read-only'));
console.log('Roles       ' + plan.users.map((u) => u.role).join(', '));
console.log('');

/* A guard rail, not a suggestion: the suite may point at production, and the
 * containment for a test bid is that it is placed and withdrawn while nobody is
 * bidding. Inside market hours that containment does not hold. */
if (writes) {
  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
    hour12: false, weekday: 'short'
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  const mins = (Number(ist.hour) % 24) * 60 + Number(ist.minute);
  const weekday = !['Sat', 'Sun'].includes(ist.weekday);
  if (weekday && mins >= 9 * 60 && mins < 16 * 60) {
    console.error('Refusing to run write flows at ' + ist.hour + ':' + ist.minute +
      ' IST on a ' + ist.weekday + '.');
    console.error('A test bid is contained by being withdrawn in the same run, and that only');
    console.error('holds while nobody is bidding. Run outside 09:00-16:00 IST on a trading day,');
    console.error('or set writes_allowed=no on the Environment row for a read-only pass.\n');
    process.exit(3);
  }
}

if (only) pass.push('--project=' + only);

const bin = path.join(__dirname, 'node_modules', '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
const child = spawn(bin, ['test'].concat(pass), { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
