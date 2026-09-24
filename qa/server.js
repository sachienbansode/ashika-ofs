'use strict';
/**
 * The QA console.
 *
 * A separate application with its own door, its own storage and no connection
 * of any kind to the OFS app or its databases. It talks to OFS the same way a
 * person does — through a browser, over HTTP — and that is the point: it can be
 * deployed, restarted or removed without touching anything the desk depends on.
 *
 * What it does: hand out the plan template, take a filled one back, run the
 * suite against it in a browser you choose, show the log as it happens, and
 * keep each run's Excel and HTML report for seven days.
 *
 * What it deliberately does not do: hold a schema, share a session with OFS, or
 * know any OFS credential of its own. The credentials are in the workbook the
 * operator uploads, they live only in that run's directory, and they go when the
 * run is purged.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
/* Pinned to archiver 7. Version 8 dropped the factory for a set of exported
 * classes, so `archiver('zip')` becomes "archiver is not a function" - and it
 * surfaces at download time rather than at startup, which is the worst place
 * for a packaging change to appear. The caret in package.json is ^7. */
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const auth = require('./lib/auth');
const runs = require('./lib/runs');

const app = express();
const PORT = Number(process.env.OFS_QA_PORT || 4100);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

/* The console can start a process and stores workbooks full of credentials, so
 * it says no to being framed and no to being sniffed. */
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* ------------------------------------------------------------------ the door */

const LOGIN_WAIT = new Map();               // ip -> { n, until }

app.get('/login', (req, res) => {
  if (auth.read(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  if (!auth.configured()) {
    return res.status(503).json({ error: 'not_configured',
      message: 'No operator account yet. Run "npm run set-password" on the server.' });
  }
  const ip = req.ip || 'unknown';
  const w = LOGIN_WAIT.get(ip);
  if (w && w.until > Date.now()) {
    return res.status(429).json({ error: 'too_many',
      message: 'Too many attempts. Try again in ' +
        Math.ceil((w.until - Date.now()) / 1000) + 's.' });
  }
  const ok = await auth.check(req.body && req.body.user, req.body && req.body.password);
  if (!ok) {
    const n = ((w && w.n) || 0) + 1;
    // Back off rather than lock out: an operator who mistypes twice at 2am
    // should not need somebody else to let them back in.
    LOGIN_WAIT.set(ip, { n, until: Date.now() + Math.min(n * n * 1000, 60000) });
    return res.status(401).json({ error: 'bad_credentials', message: 'User or password is incorrect.' });
  }
  LOGIN_WAIT.delete(ip);
  auth.issue(res, String(req.body.user));
  res.json({ ok: true });
});

app.post('/logout', (req, res) => { auth.clear(res); res.json({ ok: true }); });

/* ------------------------------------------------------------------- the page */

app.get('/', auth.requirePage, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use('/assets', express.static(path.join(__dirname, 'public'), {
  index: false, maxAge: '1h'
}));

/* ------------------------------------------------------------------ the plan */

/** The blank template, generated fresh so it can never drift from the reader. */
app.get('/api/template', auth.requireApi, (req, res, next) => {
  const tmp = path.join(runs.ensure(), 'OFS_Test_Plan_TEMPLATE.xlsx');
  const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'make-plan.js'), tmp],
    { stdio: 'ignore' });
  child.on('exit', (code) => {
    if (code !== 0 || !fs.existsSync(tmp)) {
      return next(new Error('Could not generate the template.'));
    }
    res.download(tmp, 'OFS_Test_Plan_TEMPLATE.xlsx');
  });
});

/* ------------------------------------------------------------------- running */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // The runner will reject anything that is not a workbook anyway, but an
    // upload endpoint that accepts arbitrary bytes is a file drop.
    const ok = /\.xlsx$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Upload the .xlsx plan, not ' + (file.originalname || 'that')), ok);
  }
});

const BROWSERS = ['chromium', 'chrome', 'edge'];
const ROLES = ['', 'desk', 'ap', 'client'];

/** At most one run at a time: two browsers against one desk is not a test. */
let CURRENT = null;

app.get('/api/state', auth.requireApi, (req, res) => {
  res.json({
    user: req.qa.user,
    running: CURRENT ? { id: CURRENT.id, startedAt: CURRENT.startedAt } : null,
    keepDays: runs.KEEP_DAYS,
    browsers: BROWSERS
  });
});

app.post('/api/runs', auth.requireApi, upload.single('plan'), (req, res) => {
  if (CURRENT) {
    return res.status(409).json({ error: 'busy',
      message: 'A run is already going. Wait for it, or stop it.' });
  }
  if (!req.file) return res.status(400).json({ error: 'no_plan', message: 'Choose the plan workbook.' });

  const env = String(req.body.env || '').trim();
  const browser = String(req.body.browser || 'chromium').trim().toLowerCase();
  const only = String(req.body.only || '').trim().toLowerCase();
  if (!env) return res.status(400).json({ error: 'no_env', message: 'Name the environment row, e.g. UAT.' });
  if (!BROWSERS.includes(browser)) return res.status(400).json({ error: 'bad_browser' });
  if (!ROLES.includes(only)) return res.status(400).json({ error: 'bad_role' });

  const id = runs.newId();
  const dir = path.join(runs.ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const plan = path.join(dir, 'plan.xlsx');
  fs.writeFileSync(plan, req.file.buffer);

  const meta = runs.writeMeta(dir, {
    id, env, browser, only: only || 'all',
    plan: req.file.originalname,
    by: req.qa.user,
    startedAt: new Date().toISOString(),
    finishedAt: null, status: 'running', exitCode: null,
    totals: null
  });

  const log = fs.createWriteStream(path.join(dir, 'run.log'), { flags: 'a' });
  const args = [path.join(__dirname, 'run.js'),
    '--book', plan, '--env', env, '--browser', browser, '--out', dir];
  if (only) args.push('--only', only);

  /* Headless, always, on this path. There is nobody at the server to type an
   * OTP into a window, so a run started from here can only cover accounts that
   * sign in without one. Where a code step appears, the suite says which column
   * on the Users sheet to set rather than hanging. */
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: Object.assign({}, process.env, { HEADLESS: '1', FORCE_COLOR: '0' })
  });
  CURRENT = { id, child, startedAt: meta.startedAt };

  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on('exit', (code, signal) => {
    log.end('\n--- finished: exit ' + code + (signal ? ' (' + signal + ')' : '') + ' ---\n');
    runs.update(id, {
      finishedAt: new Date().toISOString(),
      status: signal ? 'stopped' : code === 0 ? 'passed' : 'failed',
      exitCode: code,
      totals: totalsFromLog(path.join(dir, 'run.log'))
    });
    CURRENT = null;
    runs.purge();
  });

  res.status(201).json({ id });
});

/** The counts the reporter prints, so the list can show them without the Excel. */
function totalsFromLog(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    const m = /(\d+) case\(s\) — (\d+) passed, (\d+) failed, (\d+) skipped/.exec(t);
    if (!m) return null;
    return { cases: +m[1], passed: +m[2], failed: +m[3], skipped: +m[4] };
  } catch (e) { return null; }
}

app.post('/api/runs/:id/stop', auth.requireApi, (req, res) => {
  if (!CURRENT || CURRENT.id !== req.params.id) {
    return res.status(404).json({ error: 'not_running' });
  }
  CURRENT.child.kill('SIGTERM');
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ the list */

app.get('/api/runs', auth.requireApi, (req, res) => {
  res.json({ runs: runs.list(), running: CURRENT ? CURRENT.id : null, keepDays: runs.KEEP_DAYS });
});

app.get('/api/runs/:id', auth.requireApi, (req, res) => {
  const dir = runs.dirOf(req.params.id);
  if (!dir) return res.status(404).json({ error: 'not_found' });
  const meta = runs.readMeta(dir) || {};
  const from = Math.max(0, Number(req.query.from) || 0);
  let log = '', size = 0;
  try {
    const f = path.join(dir, 'run.log');
    size = fs.statSync(f).size;
    if (size > from) {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(Math.min(size - from, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      log = buf.toString('utf8');
    }
  } catch (e) { /* the log may not exist for a moment at the very start */ }
  res.json({
    run: Object.assign({ id: req.params.id }, meta),
    running: !!(CURRENT && CURRENT.id === req.params.id),
    log, at: from + Buffer.byteLength(log), size,
    has: {
      xlsx: !!runs.fileOf(req.params.id, 'xlsx'),
      html: !!runs.fileOf(req.params.id, 'html')
    }
  });
});

app.delete('/api/runs/:id', auth.requireApi, (req, res) => {
  if (CURRENT && CURRENT.id === req.params.id) {
    return res.status(409).json({ error: 'busy', message: 'That run is still going.' });
  }
  const dir = runs.dirOf(req.params.id);
  if (!dir) return res.status(404).json({ error: 'not_found' });
  runs.rmrf(dir);
  res.json({ ok: true });
});

/* -------------------------------------------------------------- the downloads */

app.get('/api/runs/:id/xlsx', auth.requireApi, (req, res) => {
  const f = runs.fileOf(req.params.id, 'xlsx');
  if (!f) return res.status(404).json({ error: 'not_found' });
  res.download(f, path.basename(f));
});

app.get('/api/runs/:id/log', auth.requireApi, (req, res) => {
  const f = runs.fileOf(req.params.id, 'log');
  if (!f) return res.status(404).json({ error: 'not_found' });
  res.download(f, req.params.id + '.log');
});

/**
 * The HTML report, zipped.
 *
 * Playwright's report is a folder — index.html plus its data, traces and video —
 * so it is served as an archive rather than as a link into the results
 * directory. Serving that directory would also serve plan.xlsx, which holds
 * every credential the run was given.
 */
app.get('/api/runs/:id/html', auth.requireApi, (req, res) => {
  const d = runs.fileOf(req.params.id, 'html');
  if (!d) return res.status(404).json({ error: 'not_found' });
  res.attachment('OFS_Test_Report_' + req.params.id + '.zip');
  const zip = archiver('zip', { zlib: { level: 9 } });
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  zip.directory(d, false);
  zip.finalize();
});

/* ------------------------------------------------------------------------ up */

app.get('/healthz', (req, res) => res.json({ ok: true, app: 'ashika-ofs-qa' }));

app.use((err, req, res, next) => {
  const msg = err && err.message ? err.message : 'Something went wrong.';
  const code = /Upload the \.xlsx/.test(msg) || /File too large/.test(msg) ? 400 : 500;
  if (code === 500) console.error('[qa]', err);
  res.status(code).json({ error: 'failed', message: msg });
});

if (require.main === module) {
  runs.ensure();
  const gone = runs.purge();
  if (gone.length) console.log('[qa] purged ' + gone.length + ' run(s) older than ' + runs.KEEP_DAYS + ' days');
  if (!auth.configured()) {
    console.warn('[qa] NO OPERATOR ACCOUNT — run "npm run set-password" before anyone can sign in.');
  }
  app.listen(PORT, () => {
    console.log('[qa] console on http://127.0.0.1:' + PORT + '  · keeping runs ' + runs.KEEP_DAYS + ' days');
  });
  // Nightly, so a console left running for weeks does not fill the disk.
  setInterval(() => runs.purge(), 6 * 3600 * 1000).unref();
}

module.exports = app;
