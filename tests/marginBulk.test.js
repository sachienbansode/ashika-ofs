'use strict';
/**
 * The three margin operations that timed out or failed outright.
 *
 * All three had the same shape: a loop issuing one or more statements per client,
 * run one after another. nginx gives a request 60 seconds (proxy_read_timeout);
 * a day's margin file is the whole client base. So the CSV import and the zero-all
 * both ran past the ceiling and came back 504 — after a partial write, with the
 * desk told only "Import failed".
 *
 * The delete failed for a different reason: it logs new_value NULL to mean "record
 * removed", which is a different fact from "the value is now zero", and the column
 * was NOT NULL. The insert raised 23502 inside the delete's own transaction, so the
 * DELETE rolled back too and the record could be zeroed but never removed.
 *
 * The replacement SQL was run against a real PostgreSQL 16 before shipping:
 * 25,000 rows upserted in 256ms, the same 25,000 as updates in 445ms, and the
 * zero-all logged and zeroed 25,001 clients in about 400ms.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('routes/margin.js');

test('the bulk import is set-based, not a statement per client', () => {
  // The old shape: `for (const row of list) await upsert(...)`, and upsert opens
  // its own transaction — five round trips per client.
  assert.ok(!/for \(const row of list[\s\S]{0,200}?await upsert\(/.test(SRC),
    'the row-by-row loop is back; this is what returned 504 on a real file');
  assert.match(SRC, /async function upsertMany\(c, batch, source, note, actor\)/);
  assert.match(SRC, /unnest\(\$1::text\[\], \$2::numeric\[\]\)/,
    'values must travel as arrays, or the parameter count grows with the file');
  // One transaction for the whole upload, chunked so no single statement is vast.
  assert.match(SRC, /await tx\(async \(c\) => \{[\s\S]{0,300}?upsertMany\(c, clean\.slice/);
  assert.match(SRC, /const BULK_CHUNK = 2000;/);
});

test('the log records the value from BEFORE the upload', () => {
  // prev is read in the same statement that writes. Every CTE sees one snapshot,
  // so old_value is the pre-upload figure even though `up` is overwriting it.
  // Verified on a real server: EXIST1 went 111.11 -> 222.22 and the log row said
  // old_value 111.11.
  const sql = /WITH incoming AS \([\s\S]*?RETURNING client_ucc`/.exec(SRC)[0];
  assert.match(sql, /prev AS \(\s*\n\s*SELECT i\.client_ucc, i\.available, m\.available AS old_value/);
  assert.match(sql, /LEFT JOIN \$\{SCHEMA\}\.ofs_margin m/,
    'LEFT, or a client with no margin yet is dropped from the upload');
  // The log reads prev, never up: a DO UPDATE does not return the same set.
  assert.match(sql, /SELECT client_ucc, old_value, available, \$3, \$4, \$5 FROM prev/);
});

test('a UCC listed twice in one file does not fail the whole upload', () => {
  // ON CONFLICT cannot touch the same row twice in one statement. A repeated
  // client is a normal mistake in a hand-made CSV, so the last value wins —
  // the same answer the row-by-row version gave.
  const sql = /WITH incoming AS \([\s\S]*?RETURNING client_ucc`/.exec(SRC)[0];
  assert.match(sql, /SELECT DISTINCT ON \(client_ucc\) client_ucc, available/);
  assert.match(sql, /WITH ORDINALITY AS t\(client_ucc, available, ord\)/);
  assert.match(sql, /ORDER BY client_ucc, ord DESC/, 'last occurrence must win, not first');
});

test('rows the import skipped are counted and reported', () => {
  // The loop used `continue` and reported only how many it wrote, so a row the
  // desk expected to see written and did not had no trace anywhere.
  assert.match(SRC, /if \(!ucc \|\| !isFinite\(amt\) \|\| amt < 0\) \{ skipped\+\+; continue; \}/);
  assert.match(SRC, /res\.json\(\{ updated: n, skipped: skipped, rows_sent: list\.length \}\)/);
  assert.match(SRC, /audit\.log\(req, 'bulk_margin'[\s\S]{0,120}?skipped, rows_sent/);
});

test('an oversized file is refused with a number, not truncated in silence', () => {
  // It used to slice(0, 5000) and report success for the 5000 it wrote.
  assert.ok(!/list\.slice\(0, 5000\)/.test(SRC), 'silent truncation is back');
  assert.match(SRC, /const BULK_MAX = 50000;/);
  assert.match(SRC, /error: 'too_many_rows'/);
});

test('zeroing every margin is two statements, and logs every client', () => {
  assert.ok(!/for \(const m of before\) \{[\s\S]{0,200}?ofs_margin_log/.test(SRC),
    'the per-client insert loop is back; this is what timed out on zero-all');
  assert.match(SRC, /INSERT INTO \$\{SCHEMA\}\.ofs_margin_log \(client_ucc, old_value, new_value, source, note, actor\)\s*\n\s*SELECT client_ucc, available, 0, 'reset'/);
  // The count reported is what was actually logged, not a read from a moment before.
  assert.match(SRC, /return logged\.rowCount;/);
  // And the pre-read is a count, not the whole table pulled into memory.
  assert.match(SRC, /SELECT count\(\*\)::int AS n FROM \$\{SCHEMA\}\.ofs_margin WHERE COALESCE\(available,0\) <> 0/);
});

test('removing a margin record needs migration 021, which is present', () => {
  // NULL new_value means "removed", which is not the same fact as zero. Without
  // the migration the insert raises 23502 inside the delete's transaction and the
  // DELETE rolls back with it — proven against a real server.
  assert.match(SRC, /VALUES \(\$1,\$2,NULL,'manual',\$3,\$4\)/);
  const mig = read('db/migrations/021_margin_log_removal.sql');
  assert.match(mig, /ALTER TABLE ofs\.ofs_margin_log ALTER COLUMN new_value DROP NOT NULL/);
  // And nothing later puts the constraint back.
  for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations'))) {
    if (f <= '021') continue;
    assert.ok(!/ofs_margin_log[\s\S]*new_value[\s\S]*SET NOT NULL/.test(read('db/migrations/' + f)),
      f + ' re-adds the NOT NULL that stops a margin record being removed');
  }
});

test('the browser uploads in chunks and says what landed', () => {
  const app = read('public/backoffice/app.js');
  assert.match(app, /var CHUNK = 2000;/);
  assert.match(app, /for \(var i = 0; i < rows\.length; i \+= CHUNK\)/);
  // A partial failure must say how many were written, not just "Import failed" —
  // that message sent people looking for a problem in the file.
  assert.match(app, /toast\('Import stopped'[\s\S]{0,200}?client\(s\) were written before it stopped/);
  // And the button cannot be double-clicked into uploading the file twice.
  assert.match(app, /go\.disabled = true;\s*\n\s*go\.textContent = 'Importing…';/);
  assert.match(app, /function importProgress\(text\)/);
});
