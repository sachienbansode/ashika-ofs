'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ca = require('../lib/clientAuth');
const DEFAULTS = require('../lib/settings').DEFAULTS;

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const AUTH = read('routes', 'clientAuth.js');
const LIB = read('lib', 'clientAuth.js');
const SETTINGS = read('routes', 'settings.js');
const CLIENT = read('public', 'client', 'client.js');
const MIG = read('db', 'migrations', '024_client_login_reveal.sql');

/* ---------------------------------------------------------------------------
 * "We should say invalid client information if the UCC isn't found. Look at
 *  branch and AP login, it's correct."
 *
 * The branch door refuses at step one, marks the field and sends nothing. The
 * client door carried a miss to the code step and waited for a code that was
 * never coming — because the answer had to be identical either way, or the page
 * became a yes/no oracle over Ashika's client base.
 *
 * That argument rested on nothing being able to count misses. It overlooked the
 * limiter already sitting on the route.
 * ------------------------------------------------------------------------- */

test('a miss is named again, by default', () => {
  assert.equal(DEFAULTS.client_login_unknown, 'reveal',
    'the code default still hides whether the identifier matched');
  assert.match(AUTH, /String\(cfg\.client_login_unknown \|\| 'reveal'\) === 'reveal'/,
    'the route still falls back to generic');
  // A row in the table beats a code default, and 023 had turned the seed to
  // generic — so the seed has to be turned back or the default never applies.
  assert.match(MIG, /SET value = 'reveal'/);
  assert.match(MIG, /AND value = 'generic'\s*\n\s*AND updated_by IS NULL;/,
    'a desk that chose generic deliberately must keep it');
});

test('nothing is sent, and no challenge is created, for an identifier nobody has', () => {
  const i = AUTH.indexOf('if (!clients.length) {');
  assert.ok(i > 0, 'the miss branch is gone');
  const branch = AUTH.slice(i, i + 1400);
  assert.match(branch, /return res\.status\(404\)\.json\(\{\s*\n\s*error: 'no_client'/,
    'a miss no longer refuses at step one');
  // createChallenge is what sends the code, and it must sit BELOW this branch.
  assert.ok(AUTH.indexOf('ca.createChallenge(') > i,
    'a code can be sent before the miss is refused');
  assert.match(branch, /No active Ashika account found for that ' \+ what/,
    'the refusal does not name what was typed');
  assert.match(AUTH, /const what = kind === 'ucc' \? 'client code' : kind === 'mobile' \? 'mobile number' : 'email address';/,
    '"no client found" against a field they did not fill in is its own confusion');
});

test('the screen keeps a miss on step one, as the branch door does', () => {
  const i = CLIENT.indexOf('async function sendCode()');
  const f = CLIENT.slice(i, i + 3000);
  // The catch must not run the code that advances the step.
  const c = f.slice(f.indexOf('} catch (e) {'));
  assert.ok(!/setStep\(2\)/.test(c), 'a refusal still advances to the code step');
  assert.match(c, /hint\.className = 'hint bad';/, 'the field is not marked');
  assert.match(c, /\(e\.body && e\.body\.message\) \|\| e\.message/,
    'the server’s reason is discarded in favour of a generic one');
});

/* ------------------------------------------------- why that is safe to say */

test('misses are counted where they are actually recorded', () => {
  // The old comment said the throttle could not help, and it was right about
  // THAT throttle: it counts challenge rows, and a miss creates none.
  assert.match(LIB, /count\(\*\) FILTER \(WHERE ip = \$2\)\s*\)?::int\s*AS by_ip[\s\S]{0,200}ofs_client_otp/,
    'the challenge-row throttle changed shape');
  assert.match(LIB, /async function missThrottled\(ip\)/, 'nothing counts misses');
  const f = LIB.slice(LIB.indexOf('async function missThrottled'), LIB.indexOf('async function missThrottled') + 800);
  assert.match(f, /ofs_client_login_log/, 'misses are counted in the wrong table');
  assert.match(f, /reason = 'no_match'/, 'it counts every attempt, not just the misses');
  assert.match(f, /at > now\(\) - \(\$2 \|\| ' minutes'\)::interval/, 'the count has no window');
  assert.equal(ca.MISS_LIMIT, 10);
  assert.equal(ca.MISS_WINDOW_MIN, 15);
});

test('the miss is logged before it is counted, so the count includes it', () => {
  const log = AUTH.indexOf("reason: clients.length ? null : 'no_match'");
  const check = AUTH.indexOf('ca.missThrottled(ip)');
  assert.ok(log > 0 && check > log,
    'the current miss is counted before it is recorded, so the cap bites one late');
});

test('the cap answers with a refusal, not with a code', () => {
  const i = AUTH.indexOf('ca.missThrottled(ip)');
  const f = AUTH.slice(i, i + 700);
  assert.match(f, /res\.status\(429\)/);
  assert.match(f, /Too many unrecognised sign-in attempts from this connection/);
  assert.match(f, /reason: 'miss_throttled'/, 'a blocked enumeration attempt is not audited');
});

test('the HTTP layer caps sign-in starts as well, and always did', () => {
  // This is the limiter the old reasoning overlooked: ten starts per connection
  // per fifteen minutes is not a rate anyone walks a client-code range at.
  assert.match(AUTH, /const startLimiter = rateLimit\(\{ windowMs: 15 \* 60 \* 1000, max: 10/);
  assert.match(AUTH, /router\.post\('\/start', startLimiter,/, 'the start route is uncapped');
});

test('the desk can still choose the answer that reveals nothing', () => {
  assert.match(SETTINGS, /choices: \['generic', 'reveal'\]/);
  assert.match(SETTINGS, /Default is reveal\./, 'the hint still names generic as the default');
  assert.match(AUTH, /if \(!reveal\) return res\.json\(generic\);\s+\/\/ deliberately indistinguishable/,
    'generic no longer answers identically');
});

/* ---------------------------------------------------------------------------
 * Two kinds of wrong in one field, which do not clear at the same moment.
 * ------------------------------------------------------------------------- */

test('a refused VALUE and a malformed one are tracked separately', () => {
  assert.match(CLIENT, /var REFUSED = null;/, 'nothing remembers what was refused');
  const f = CLIENT.slice(CLIENT.indexOf('function refreshDetails()'),
                         CLIENT.indexOf('function refreshDetails()') + 2200);
  assert.match(f, /var refused = REFUSED !== null && el\.value\.trim\(\)\.toLowerCase\(\) === REFUSED\.id;/,
    'the refusal is not compared against what is in the box');
  // A well-formed address that belongs to nobody is still well-formed, so the
  // shape check alone set aria-invalid straight back to false.
  assert.match(f, /String\(refused \|\| \(!kind && typed && document\.activeElement !== el\)\)/,
    'the shape check still overwrites the refusal');
  assert.match(f, /toggle\('valid', !!kind && !refused\)/,
    'a refused value still gets a green tick');
});

test('the red sentence clears when they start correcting it', () => {
  const f = CLIENT.slice(CLIENT.indexOf('function refreshDetails()'),
                         CLIENT.indexOf('function refreshDetails()') + 2200);
  // The old guard was `if (!hint.classList.contains('bad'))`, which pinned the
  // first error on screen for good — the investor fixed the address and the
  // sentence telling them it was wrong stayed put.
  assert.ok(!/hint\.classList\.contains\('bad'\)/.test(f),
    'the hint is still pinned by its own class');
  assert.match(f, /\} else \{\s*\n\s*hint\.className = 'hint';/,
    'the hint never returns to its neutral state');
  assert.match(f, /hint\.textContent = REFUSED\.message;/,
    'retyping the refused value marks the field but says nothing');
});

test('only a refusal of the value is remembered', () => {
  const i = CLIENT.indexOf("async function sendCode()");
  const f = CLIENT.slice(i, i + 3200);
  assert.match(f, /REFUSED = null;\s+\/\/ this value is being asked about again/,
    'a retry of the same value starts with the old refusal still set');
  assert.match(f, /if \(e\.body && e\.body\.error === 'no_client'\) \{/,
    '"too many requests" would be remembered as a fact about the address');
});
