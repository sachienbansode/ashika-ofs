'use strict';
/**
 * The AP bid path, and the identifiers it depends on existing.
 *
 * The bug this exists for: routes/clientPortal.js called query() to stamp
 * otp_verified after an AP's bid was written, and never imported it. The bid was
 * inserted and committed; the very next line threw ReferenceError SYNCHRONOUSLY,
 * so the .catch() attached to it never ran; the handler's catch turned it into a
 * 500. So an AP was told their bid failed on a bid that existed and was Live, no
 * audit row was written for it, otp_verified stayed false on a bid the client HAD
 * confirmed, and the retry came back 409 duplicate_live_bid against a bid the AP
 * had been told did not exist.
 *
 * Nothing caught it because the line only runs with a live database and a real
 * client OTP. So: check every free identifier in the route files resolves to
 * something the module actually has.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Names a route file uses that must come from somewhere it can see. */
const DB_HELPERS = ['query', 'rows', 'one', 'tx', 'SCHEMA'];

const ROUTE_FILES = fs.readdirSync(path.join(ROOT, 'routes'))
  .filter((f) => f.endsWith('.js')).map((f) => 'routes/' + f);

test('every route file imports the database helpers it calls', () => {
  const missing = [];
  for (const file of ROUTE_FILES) {
    const src = read(file);
    const imp = /const \{([^}]*)\} = require\('\.\.\/db\/ofsAdapter'\)/.exec(src);
    const have = new Set((imp ? imp[1] : '').split(',').map((x) => x.trim()).filter(Boolean));
    // Names declared locally in the file count too.
    for (const m of src.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) have.add(m[1]);

    for (const name of DB_HELPERS) {
      const used = name === 'SCHEMA'
        ? /\$\{SCHEMA\}/.test(src)
        : new RegExp('(?<![.\\w$])' + name + '\\s*\\(', 'm').test(src);
      if (used && !have.has(name)) missing.push(file + ' calls ' + name + '() but never imports it');
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('the AP write path stamps the confirmation it just checked', () => {
  const src = read('routes/clientPortal.js');
  assert.match(src, /const \{ SCHEMA, rows, one, query \} = require\('\.\.\/db\/ofsAdapter'\);/);
  // Both branch writes — place and modify — do it, and both audit afterwards.
  const stamps = src.match(/await query\(`UPDATE \$\{SCHEMA\}\.ofs_bid SET otp_verified = true/g) || [];
  assert.equal(stamps.length, 2, 'place and modify both stamp the client confirmation');
  assert.equal((src.match(/audit\.log\(req, 'place', 'ofs_bid'/g) || []).length, 2,
    'a client-placed and an AP-placed bid must each leave an audit row');
});
