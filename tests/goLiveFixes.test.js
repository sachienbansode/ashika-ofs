'use strict';
/**
 * The pre-go-live audit findings, each pinned so it cannot come back.
 *
 * Most of these are races or fail-open defaults — the kind that pass every test
 * and every day of UAT, and then cost real money once two people use the screen at
 * the same time or somebody saves a blank field.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const d = require('../lib/domain');
const F = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------------------------------- the margin race ----- */

test('two bids cannot share the same free margin', () => {
  // validateBid checked the margin and the insert followed with nothing in
  // between — no transaction, no lock, and no constraint saying the sum of a
  // client's live bids may not exceed their margin. Two bids on DIFFERENT issues,
  // milliseconds apart, both read zero used, both passed, both inserted. The
  // partial unique index only stops two live bids on the same issue.
  const src = read('lib/bidService.js');
  assert.match(src, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/,
    'the re-check must be serialised per client');
  assert.match(src, /'ofs:margin:' \+ String\(ucc\)/, 'per client — not one global lock');
  // The re-read happens INSIDE the lock, or the lock is decoration.
  const guard = /async function marginGuard[\s\S]*?\n}/.exec(src)[0];
  assert.ok(guard.indexOf('pg_advisory_xact_lock') < guard.indexOf('sum(value)'),
    'the total is read before the lock is taken');
  // Both writers take it: placing spends margin and so does raising a bid.
  assert.match(src, /await marginGuard\(c, b\.client_ucc, ctx\.settings, value, null\)/);
  assert.match(src, /await marginGuard\(c, before\.client_ucc, ctx\.settings, value, before\.id\)/);
  // A modify excludes its own bid, or adding one share is checked against itself.
  assert.match(guard, /excludeId \? 'AND id <> \$2' : ''/);
});

test('the margin refusal reaches the screen as a rejected bid, not a 500', () => {
  assert.match(read('lib/dbErrors.js'), /const APP_ERRORS = \{ margin_exceeded: 422, stale_bid: 409 \}/);
  // Every bid-write handler must route through the translator.
  for (const [file, lines] of [['routes/bids.js', ['post', 'put', 'delete']],
                               ['routes/clientPortal.js', ['post', 'put', 'delete']]]) {
    void lines;
    const src = read(file);
    const bare = (src.match(/\} catch \(e\) \{ next\(e\); \}/g) || []).length;
    const routed = (src.match(/dbErr\.send\(res, next, e\)/g) || []).length;
    assert.ok(routed >= 3, file + ' has only ' + routed + ' handlers that translate app errors');
    void bare;
  }
});

/* ------------------------------------------------ the modify/cancel race ----- */

test('a modify cannot resurrect a bid that was just withdrawn', () => {
  const src = read('lib/bidService.js');
  // status='Live' was written with a WHERE naming only the id, and the "is it
  // cancelled?" check sat in the route — before validation and an OTP round-trip.
  // A client withdrew at 15:09, the desk's in-flight modify put the row back to
  // Live, and it went into the 15:15 file.
  assert.match(src, /WHERE id = \$8 AND status = \$9 RETURNING \*/);
  assert.match(src, /WHERE id = \$1 AND status = \$3 RETURNING \*/, 'cancel needs the same guard');
  assert.equal((src.match(/e\.code = 'stale_bid'/g) || []).length, 2,
    'both writers must say they lost the race rather than winning it');
});

/* ------------------------------------------------------- fail-open limits ---- */

test('a blank or zeroed limit falls back to the SEBI figure, never to "no limit"', () => {
  const at = { now: new Date('2026-09-02T11:00:00+05:30') };
  for (const bad of ['', 0, null, 'abc', undefined]) {
    const s = Object.assign({}, F.SETTINGS, { hni_min: bad, retail_cap: bad });
    // An HNI bid of ₹1,000 must still be refused.
    const hni = d.validateBid(F.ISSUE, F.bid({ category: 'HNI', qty: 1, price: 390 }),
      F.ctx(Object.assign({ settings: s }, at)));
    assert.ok(hni.some((e) => /HNI bid must be at least/.test(e)),
      'the non-retail minimum switched off for hni_min=' + JSON.stringify(bad));
    // And a ₹3 lakh retail bid must still breach the cap.
    const ret = d.validateBid(F.ISSUE, F.bid({ category: 'Retail', qty: 800, price: 390 }),
      F.ctx(Object.assign({ settings: s }, at)));
    assert.ok(ret.some((e) => /2,00,000|200000/.test(e)),
      'the retail cap switched off for retail_cap=' + JSON.stringify(bad));
  }
});

test('the tick check tests the price that will be stored', () => {
  // It rounded to paise first, so anything within half a paisa of a tick multiple
  // passed. The row then stored the unrounded price and the exchange file rounded
  // it again — so the exchange got a price the client never entered.
  const issue = Object.assign({}, F.ISSUE, { tick: 0.05, floor_price: 100, cut_price_min: 100 });
  const at = F.ctx({ now: new Date('2026-09-02T11:00:00+05:30') });
  const tickErr = (p) => d.validateBid(issue, F.bid({ category: 'Retail', qty: 10, price: p }), at)
    .filter((e) => /tick/.test(e));
  for (const bad of [100.001, 100.004, 100.049, 100.026]) {
    assert.equal(tickErr(bad).length, 1, bad + ' was accepted as a tick multiple');
  }
  for (const good of [100, 100.05, 100.10, 105.25]) {
    assert.deepEqual(tickErr(good), [], good + ' is a valid tick multiple and was refused');
  }
});

/* --------------------------------------------------- the second clock -------- */

test('a withdrawal is gated on the category window, not only the desk cut-off', async () => {
  const bids = require('../lib/bidService');
  const issue = Object.assign({}, F.ISSUE);           // HNI 01-Sep, Retail 02-Sep
  // During the HNI window: nothing to say.
  assert.equal(await bids.cancelWindowMessage(issue, 'HNI', new Date('2026-09-01T11:00:00+05:30')), null);
  // The day AFTER the HNI window — the case that shipped open. The book would say
  // cancelled while the exchange still held the bid. The desk cut-off cannot reach
  // this one: it moves the hour, never the day.
  const m = await bids.cancelWindowMessage(issue, 'HNI', new Date('2026-09-02T14:00:00+05:30'));
  assert.match(m, /window for COALINDIA is closed/);
  assert.match(m, /Contact the OFS desk/);
  // Both portals and the desk consult it.
  assert.equal((read('routes/clientPortal.js').match(/bids\.cancelWindowMessage\(/g) || []).length, 2);
  assert.match(read('routes/bids.js'), /bids\.cancelWindowMessage\(/);
  // The desk keeps its override, and it must cover the new clock too.
  assert.match(read('routes/bids.js'),
    /if \(catShut && String\(req\.body && req\.body\.force\) !== 'true'\)/);
});

/* ----------------------------------------------------- enumeration ----------- */

test('the desk login no longer says which addresses are real accounts', () => {
  const src = read('routes/staffAuth.js');
  // The M365 hint was returned BEFORE the password was consulted, so anyone could
  // separate real, active staff addresses from invented ones with no credential.
  assert.match(src, /if \(block === 'm365' && ok\) \{/);
  const body = src.slice(src.indexOf('const ok = await bcrypt.compare'));
  assert.ok(body.indexOf("block === 'm365' && ok") < body.indexOf('return res.status(401).json(BAD_CREDS)'),
    'the hint must still come before the generic failure, but only for a correct password');
});

test('the investor login names a miss, and the desk can still choose otherwise', () => {
  /* This defaulted to 'generic' — the same answer whether or not the identifier
   * matched — on the grounds that naming a miss is a yes/no oracle over the
   * client base. The reasoning overlooked the limiter already on the route:
   * POST /client/auth/start is capped at ten per connection per fifteen minutes,
   * and misses are now counted again under that. What 'generic' cost was paid by
   * every investor who mistyped, and left at a code box that would never fill. */
  assert.match(read('routes/clientAuth.js'), /cfg\.client_login_unknown \|\| 'reveal'/);
  assert.match(read('lib/settings.js'), /client_login_unknown: 'reveal'/);
  // A row in the table beats a code default, so the seed is turned back too.
  assert.match(read('db/migrations/024_client_login_reveal.sql'), /SET value = 'reveal'/);
  // And the desk can still change it — the code was built around a setting that
  // was never in the editable list, so nobody could reach it.
  assert.match(read('routes/settings.js'), /client_login_unknown: \{[\s\S]{0,600}?choices: \['generic', 'reveal'\]/);
});

/* ----------------------------------------------------------- PII ------------- */

test('the margin list masks like every other desk list', () => {
  const src = read('routes/margin.js');
  assert.match(src, /maskRows\(await ld\.enrich\(r, 'client_ucc'\), canViewPII\(req, 'ofs-desk'\)\)/);
  assert.ok(!/res\.json\(\{ margins: await ld\.enrich/.test(src), 'the unmasked call is back');
});

/* ------------------------------------------- the confirmation and the amount -- */

test('a client’s code cannot authorise a bid they were not shown', () => {
  const otp = require('../lib/bidOtp');
  const shown = { category: 'Retail', qty: 500, price: 400, exchange: 'BSE' };
  const placed = { category: 'Retail', qty: 20000, price: 400, exchange: 'BSE' };
  assert.notEqual(otp.termsHash(shown), otp.termsHash(placed),
    'the code was approved for ₹2 lakh and spent on ₹80 lakh');

  // The same bid through two different layers must hash the same, or every honest
  // bid is refused: the browser sends strings, the database returns numerics.
  assert.equal(otp.termsHash({ category: 'Retail', qty: '500', price: '400.0000', exchange: 'bse' }),
    otp.termsHash(shown));
  // Every material term is in it.
  for (const change of [{ category: 'HNI' }, { qty: 501 }, { price: 400.05 },
                        { exchange: 'NSE' }, { is_cutoff: true }]) {
    assert.notEqual(otp.termsHash(Object.assign({}, shown, change)), otp.termsHash(shown),
      'changing ' + Object.keys(change)[0] + ' does not change the binding');
  }
  // A cancellation has no terms of its own, and nothing is invented for it.
  assert.equal(otp.termsHash(null), null);

  const src = read('lib/bidOtp.js');
  assert.match(src, /if \(row\.terms_hash\) \{/, 'a code issued before the column existed still works');
  assert.match(src, /return \{ ok: false, reason: 'terms_changed' \}/);
  assert.match(read('db/migrations/022_bid_otp_terms.sql'), /ADD COLUMN IF NOT EXISTS terms_hash/);
});

test('the terms checked are the bid being written, not what the request claims', () => {
  // `b` is the normalised bid handed to insertBid/updateBid, so there is no second
  // reading of the body that could differ from it.
  assert.match(read('routes/bids.js'), /action: 'place', terms: b \}\)\) return;/);
  assert.match(read('routes/clientPortal.js'), /action: 'place', terms: b \}\)\)\) return;/);
  for (const f of ['routes/bids.js', 'routes/clientPortal.js']) {
    assert.match(read(f), /bidId: before\.id,\n\s*terms: b \}/, f + ' does not pin a modify');
  }
});

/* ------------------------------------------------------------ margin log ----- */

test('a margin record can be removed, and the log says removed rather than zero', () => {
  assert.match(read('db/migrations/021_margin_log_removal.sql'),
    /ALTER COLUMN new_value DROP NOT NULL/);
  // The delete logs NULL deliberately — and it shares the delete's transaction, so
  // the NOT NULL rolled the delete back and the desk saw "new_value is required".
  assert.match(read('routes/margin.js'), /VALUES \(\$1,\$2,NULL,'manual',\$3,\$4\)/);
});
