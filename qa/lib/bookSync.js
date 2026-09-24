'use strict';
/**
 * The workbook, read synchronously.
 *
 * playwright.config.js needs the environment before it can define anything —
 * the base URL, which projects make sense, where the results file goes — and a
 * config file cannot await. ExcelJS is async all the way down, so the read runs
 * in a child process and comes back as JSON.
 *
 * A child process rather than a sync xlsx parser: an .xlsx is a zip of XML and
 * parsing it by hand to save one process launch is how you end up maintaining a
 * spreadsheet reader. This costs about 200ms, once per run.
 *
 * Failing here is the right place to fail. A missing or malformed plan stops the
 * run before a browser is launched, with a message that says what to do, rather
 * than forty tests all timing out on `undefined/backoffice/`.
 */
const { execFileSync } = require('child_process');
const path = require('path');

let cache = null;

function loadSync() {
  if (cache) return cache;
  const script = path.join(__dirname, '..', 'scripts', 'read-book.js');
  let out;
  try {
    out = execFileSync(process.execPath, [script].concat(process.argv.slice(2)), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (e) {
    const said = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error('\n\n' + (said || 'Could not read the test plan workbook.') + '\n');
  }
  cache = JSON.parse(out);
  return cache;
}

module.exports = { loadSync };
