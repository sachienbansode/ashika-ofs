'use strict';
/**
 * Documents attached to an issue — the circular or notice that created it.
 *
 * Links are stored as an address. Files are written to OFS_DOC_DIR under a name this
 * app chooses, never the name the browser sent: an uploaded filename is attacker-
 * controlled text, and "../../.env" is a filename.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SCHEMA, rows, one, query } = require('../db/ofsAdapter');

const DIR = path.resolve(process.env.OFS_DOC_DIR || path.join(__dirname, '..', 'var', 'docs'));
const MAX_BYTES = Number(process.env.OFS_DOC_MAX_BYTES || 8 * 1024 * 1024);

/** Only formats a circular actually arrives in. No HTML, nothing executable. */
const MIME = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'image/png': '.png',
  'image/jpeg': '.jpg'
};

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true, mode: 0o750 });
  return DIR;
}

/**
 * A URL we are willing to store and later render as a link. http/https only —
 * `javascript:` and `data:` in an href are how a stored link becomes stored XSS.
 */
function safeUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
}

/** Keep only what is safe to show; the stored name is ours, so this is display-only. */
function cleanName(v) {
  return String(v || '')
    .replace(/[\\/]/g, ' ')
    .replace(/[^\w .,()\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || null;
}

async function list(issueId) {
  return rows(
    `SELECT id, issue_id, kind, source, title, storage, url, orig_name, mime, bytes,
            sha256, circular_id, added_by, added_at
       FROM ${SCHEMA}.ofs_issue_doc
      WHERE issue_id = $1 ORDER BY added_at DESC, id DESC`, [issueId]);
}

async function addLink({ issueId, kind, source, title, url, circularId, actor }) {
  const href = safeUrl(url);
  if (!href) { const e = new Error('That is not a valid http(s) link.'); e.status = 422; throw e; }
  return one(
    `INSERT INTO ${SCHEMA}.ofs_issue_doc
       (issue_id, kind, source, title, storage, url, circular_id, added_by)
     VALUES ($1,$2,$3,$4,'link',$5,$6,$7)
     ON CONFLICT (issue_id, url) WHERE storage = 'link' DO UPDATE
       SET title = EXCLUDED.title, kind = EXCLUDED.kind, source = EXCLUDED.source
     RETURNING *`,
    [issueId, kind || 'circular', source || 'manual', cleanName(title) || 'Announcement',
     href, circularId || null, actor || null]);
}

async function addFile({ issueId, kind, source, title, origName, mime, buffer, actor }) {
  const ext = MIME[String(mime || '').toLowerCase()];
  if (!ext) {
    const e = new Error('Only PDF, ZIP, PNG or JPEG can be attached.');
    e.status = 415; throw e;
  }
  if (!buffer || !buffer.length) { const e = new Error('The upload was empty.'); e.status = 422; throw e; }
  if (buffer.length > MAX_BYTES) {
    const e = new Error('That file is larger than ' + Math.round(MAX_BYTES / 1024 / 1024) + ' MB.');
    e.status = 413; throw e;
  }

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const name = sha.slice(0, 32) + ext;             // our name, derived from content
  ensureDir();
  const full = path.join(DIR, name);
  if (!fs.existsSync(full)) fs.writeFileSync(full, buffer, { mode: 0o640 });

  return one(
    `INSERT INTO ${SCHEMA}.ofs_issue_doc
       (issue_id, kind, source, title, storage, file_name, orig_name, mime, bytes, sha256, added_by)
     VALUES ($1,$2,$3,$4,'file',$5,$6,$7,$8,$9,$10) RETURNING *`,
    [issueId, kind || 'notice', source || 'manual',
     cleanName(title) || cleanName(origName) || 'Document',
     name, cleanName(origName), String(mime).toLowerCase(), buffer.length, sha, actor || null]);
}

async function get(issueId, docId) {
  return one(`SELECT * FROM ${SCHEMA}.ofs_issue_doc WHERE id = $1 AND issue_id = $2`, [docId, issueId]);
}

/** The path on disk, re-derived from our own stored name — never joined with input. */
function filePath(doc) {
  const name = path.basename(String(doc.file_name || ''));
  if (!name || name.indexOf('..') >= 0) return null;
  const full = path.join(DIR, name);
  return full.startsWith(DIR + path.sep) ? full : null;
}

async function remove(issueId, docId) {
  const doc = await get(issueId, docId);
  if (!doc) return null;
  await query(`DELETE FROM ${SCHEMA}.ofs_issue_doc WHERE id = $1`, [docId]);

  // Only unlink the file when nothing else points at it — the name is the content
  // hash, so two issues attaching the identical PDF share one file on disk.
  if (doc.storage === 'file') {
    const still = await one(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.ofs_issue_doc WHERE file_name = $1`, [doc.file_name]);
    const p = filePath(doc);
    if (still && still.n === 0 && p) { try { fs.unlinkSync(p); } catch (e) { /* gone already */ } }
  }
  return doc;
}

/** Counts for a list view, so the table can show a badge without N queries. */
async function countsFor(issueIds) {
  if (!issueIds || !issueIds.length) return {};
  const r = await rows(
    `SELECT issue_id, count(*)::int AS n FROM ${SCHEMA}.ofs_issue_doc
      WHERE issue_id = ANY($1) GROUP BY issue_id`, [issueIds]);
  const out = {};
  for (const x of r) out[x.issue_id] = x.n;
  return out;
}

module.exports = { DIR, MAX_BYTES, MIME, safeUrl, cleanName, ensureDir,
  list, addLink, addFile, get, filePath, remove, countsFor };
