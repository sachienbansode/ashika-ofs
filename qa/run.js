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
let browser = process.env.OFS_QA_CHANNEL || '';
let slow = process.env.OFS_QA_SLOWMO || '';
let out = process.env.OFS_QA_OUT || '';

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
  if (a === '--book' || a.startsWith('--book=')) book = take();
  else if (a === '--env' || a.startsWith('--env=')) env = take();
  else if (a === '--only' || a.startsWith('--only=')) only = take();
  // Real Chrome rather than the bundled Chromium. Worth having: the desk uses
  // Chrome, and "it works in Chromium" is not quite the same claim.
  else if (a === '--browser' || a.startsWith('--browser=')) browser = take();
  // Slow the actions down so a person can follow what is happening.
  else if (a === '--slow' || a.startsWith('--slow=')) slow = a.includes('=') ? take() : (argv[i + 1] && /^\d+$/.test(argv[i + 1]) ? argv[++i] : '400');
  // Everything one run produces, under one directory. The QA server gives each
  // run its own, so two runs cannot overwrite each other's report.
  else if (a === '--out' || a.startsWith('--out=')) out = take();
  else pass.push(a);
}

if (book) process.env.OFS_QA_BOOK = path.resolve(book);
if (env) process.env.OFS_QA_ENV = env;

/* chromium is Playwright's own build; chrome and msedge are the real browsers
 * already installed on the machine. Anything else is a typo, and a typo that
 * silently fell back to Chromium would make "we tested on Chrome" untrue. */
const CHANNELS = { chromium: '', chrome: 'chrome', edge: 'msedge', msedge: 'msedge' };
if (browser) {
  const key = String(browser).toLowerCase();
  if (!(key in CHANNELS)) {
    console.error('Unknown --browser "' + browser + '". Use chromium, chrome or edge.');
    process.exit(2);
  }
  if (CHANNELS[key]) process.env.OFS_QA_CHANNEL = CHANNELS[key];
}
if (slow) process.env.OFS_QA_SLOWMO = String(Number(slow) || 400);
if (out) process.env.OFS_QA_OUT = path.resolve(out);

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
console.log('Browser     ' + (process.env.OFS_QA_CHANNEL || 'chromium (bundled)') +
  (process.env.HEADLESS === '1' ? ' · headless' : ' · on screen') +
  (process.env.OFS_QA_SLOWMO ? ' · ' + process.env.OFS_QA_SLOWMO + 'ms between actions' : ''));
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

/* Run Playwright's CLI with node, not through a shell.
 *
 * The obvious shape is to spawn node_modules/.bin/playwright.cmd with
 * shell:true on Windows, and it is wrong the moment any path contains a space:
 * a shell spawn CONCATENATES the arguments instead of passing them as a vector,
 * so "D:\sachin b\projects\OFS\qa" was handed to cmd as two words and it tried
 * to run D:\sachin. Resolving the CLI entry point and running it with the same
 * node binary skips the shell entirely, which is also one less thing between an
 * exit code and this process. */
const cli = require.resolve('@playwright/test/cli');
const child = spawn(process.execPath, [cli, 'test'].concat(pass), { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code == null ? (signal ? 1 : 0) : code));
