'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const PORTAL = read('routes', 'clientPortal.js');
const CLIENT = read('public', 'client', 'client.js');

/* ---------------------------------------------------------------------------
 * "Client name is not available in csv download."
 *
 * The file has a Client column and it came out empty on every row of an
 * investor's own download. The endpoint it is built from skipped enrichment
 * entirely for a client session — a client knows who they are, which is true of
 * the screen and wrong about a file they keep or forward on.
 * ------------------------------------------------------------------------- */

test('the CSV asks for a name, so the endpoint has to send one', () => {
  const i = CLIENT.indexOf('async function downloadBidsCsv()');
  const f = CLIENT.slice(i, i + 2000);
  assert.match(f, /'Client UCC', 'Client', 'Branch'/, 'the column is gone');
  assert.match(f, /x\.client_name \|\| ''/, 'the column is filled from somewhere else now');
  // Built from the API rather than the drawn rows, so every page is in the file.
  assert.match(f, /api\('\/client\/api\/me\/bids\?all=1'\)/);
});

test('a client session gets its own name on its own rows', () => {
  assert.match(PORTAL, /async function ownName\(req, list\)/, 'nothing fills the name in');
  const f = PORTAL.slice(PORTAL.indexOf('async function ownName'), PORTAL.indexOf('async function ownName') + 900);
  assert.match(f, /String\(\(req\.portal && req\.portal\.ucc\) \|\| ''\)/,
    'the name comes from the request rather than from the session');
  assert.match(f, /await ld\.findByUcc\(ucc\)/);
  assert.match(f, /Object\.assign\(\{\}, r, \{ client_name: name \}\)/);
  assert.match(PORTAL, /\? await ownName\(req, b\)/, 'the bids list still skips a client session');
});

test('one lookup for the session, not one per row', () => {
  const f = PORTAL.slice(PORTAL.indexOf('async function ownName'), PORTAL.indexOf('async function ownName') + 900);
  assert.ok(!/list\.map\(async/.test(f), 'a lookup per row');
  assert.ok(f.indexOf('await ld.findByUcc') < f.indexOf('list.map'),
    'the lookup happens inside the map');
  // enrich() would also pull back PAN, mobile and email, which none of these
  // rows print — a client session is unmasked, so that is PII fetched for nothing.
  assert.ok(!/ld\.enrich/.test(f), 'enrich pulls contact details these rows do not need');
});

test('a branch still gets every client’s name, masked', () => {
  assert.match(PORTAL, /: maskPortalRows\(req, await ld\.enrich\(b, 'client_ucc'\)\);/,
    'the branch path changed — a branch reading bare UCCs cannot tell its clients apart');
});
