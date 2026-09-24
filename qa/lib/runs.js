'use strict';
/**
 * Runs, on disk.
 *
 * No database. Each run is a directory under results/ holding everything it
 * produced — the plan it was given, the log it wrote, the Excel, the HTML report
 * and any failure artifacts — plus a meta.json that is the index. That is the
 * whole storage layer, and it is deliberate: a QA tool that needs a schema, a
 * migration and a connection string to record that a button rendered is a
 * second system to keep alive.
 *
 * It also means a run is portable. The directory can be zipped and sent to
 * whoever asked, and it still opens.
 *
 * Runs are kept for seven days. Old ones stop being evidence of anything once
 * the code has moved on, and the HTML report with its traces and video is the
 * bulk of it — a fortnight of nightly runs is gigabytes for something nobody
 * will open.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'results');
const KEEP_DAYS = Number(process.env.OFS_QA_KEEP_DAYS || 7);

function ensure() {
  fs.mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

/** A sortable, readable, collision-free id: 20260925-004612-a3f1. */
function newId() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' +
         p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + '-' +
         Math.random().toString(16).slice(2, 6);
}

/* An id from outside is a path fragment until proven otherwise: ../ in a run id
 * would read and serve any file on the machine. Checked once, here, so no route
 * has to remember to. */
const ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
function dirOf(id) {
  if (!ID.test(String(id || ''))) return null;
  const d = path.join(ROOT, id);
  return fs.existsSync(d) ? d : null;
}

function metaPath(dir) { return path.join(dir, 'meta.json'); }

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(metaPath(dir), 'utf8')); }
  catch (e) { return null; }
}

function writeMeta(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
  return meta;
}

function update(id, patch) {
  const dir = dirOf(id);
  if (!dir) return null;
  const meta = Object.assign(readMeta(dir) || {}, patch);
  return writeMeta(dir, meta);
}

/** Every run, newest first. */
function list() {
  ensure();
  return fs.readdirSync(ROOT)
    .filter((n) => ID.test(n))
    .sort().reverse()
    .map((id) => {
      const m = readMeta(path.join(ROOT, id));
      return m ? Object.assign({ id }, m) : null;
    })
    .filter(Boolean);
}

/** The file a download asks for, or null. Never a path the caller supplied. */
function fileOf(id, what) {
  const dir = dirOf(id);
  if (!dir) return null;
  if (what === 'xlsx') {
    const f = fs.readdirSync(dir).find((n) => n.endsWith('.xlsx') && n !== 'plan.xlsx');
    return f ? path.join(dir, f) : null;
  }
  if (what === 'log') {
    const f = path.join(dir, 'run.log');
    return fs.existsSync(f) ? f : null;
  }
  if (what === 'html') {
    const d = path.join(dir, 'html');
    return fs.existsSync(d) ? d : null;
  }
  return null;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* gone already */ }
}

/**
 * Drop anything older than the retention window.
 *
 * By the directory's own date prefix rather than its mtime: a run whose folder
 * was touched by a copy or a backup is still a run from three weeks ago, and
 * mtime would keep it forever.
 */
function purge(days) {
  ensure();
  const keep = Number(days || KEEP_DAYS);
  const cut = new Date(Date.now() - keep * 86400000);
  const stamp = cut.getUTCFullYear() + String(cut.getUTCMonth() + 1).padStart(2, '0') +
                String(cut.getUTCDate()).padStart(2, '0');
  const gone = [];
  for (const n of fs.readdirSync(ROOT)) {
    if (!ID.test(n)) continue;
    if (n.slice(0, 8) < stamp) { rmrf(path.join(ROOT, n)); gone.push(n); }
  }
  return gone;
}

module.exports = { ROOT, KEEP_DAYS, ensure, newId, dirOf, readMeta, writeMeta, update, list, fileOf, purge, rmrf };
