'use strict';
/**
 * Fail fast on a bad .env before the app touches a production database.
 *   npm run check-env
 * Prints nothing secret — only which keys are missing, blank or still placeholders.
 */
// dotenv is optional here on purpose: this script must still run before `npm install`,
// reading whatever is already exported in the shell.
try { require('dotenv').config(); } catch (e) { console.log('(dotenv not installed — reading the shell environment only)'); }

const E = process.env;
let bad = 0, warn = 0;
const fail = (k, m) => { bad++; console.log('  MISSING  ' + k + (m ? '  — ' + m : '')); };
const flag = (k, m) => { warn++; console.log('  CHECK    ' + k + (m ? '  — ' + m : '')); };
const ok = (k, m) => console.log('  ok       ' + k + (m ? '  — ' + m : ''));

/** A connection is satisfied by a URL or by the discrete host/db/user trio. */
function connection(prefix, label) {
  const url = E[prefix + '_DATABASE_URL'];
  const discrete = E[prefix + '_PG_HOST'] && E[prefix + '_PG_DATABASE'] && E[prefix + '_PG_USER'];
  if (!url && !discrete) {
    return fail(prefix + '_DATABASE_URL', label + ': set the URL, or all of _PG_HOST/_PG_DATABASE/_PG_USER');
  }
  if (url) {
    try {
      const u = new URL(url);
      if (!u.pathname || u.pathname === '/') fail(prefix + '_DATABASE_URL', 'no database name in the URL path');
      if (u.password) flag(prefix + '_DATABASE_URL', 'password is embedded in the URL — put it in ' + prefix + '_PG_PASSWORD instead');
      ok(prefix, label + ' -> ' + u.hostname + ':' + (u.port || 5432) + u.pathname);
    } catch (e) { return fail(prefix + '_DATABASE_URL', 'malformed URL'); }
  } else {
    ok(prefix, label + ' -> ' + E[prefix + '_PG_HOST'] + '/' + E[prefix + '_PG_DATABASE']);
  }
  if (!E[prefix + '_PG_PASSWORD'] && !(url && new URL(url).password)) {
    fail(prefix + '_PG_PASSWORD', label + ': no password supplied');
  }
  if (String(E[prefix + '_PG_SSL']) !== 'true') {
    flag(prefix + '_PG_SSL', 'not "true" — the prod server expects TLS');
  }
}

console.log('\nDatabases');
connection('OFS', 'OFS state');
connection('ANANTA', 'LD / admin');

console.log('\nSecrets shared with the platform (must match byte for byte)');
if (!E.JWT_SECRET) fail('JWT_SECRET', 'staff tokens are issued by the platform; a mismatch rejects every login');
else ok('JWT_SECRET', 'set (' + E.JWT_SECRET.length + ' chars)');
if (!E.API_KEY_SECRET) flag('API_KEY_SECRET', 'unset — the SMTP password will not decrypt, so email is disabled');
else ok('API_KEY_SECRET', 'set');

console.log('\nApp');
const prod = E.NODE_ENV === 'production';
if (!E.NODE_ENV) flag('NODE_ENV', 'unset — set it to production before go-live');
else ok('NODE_ENV', E.NODE_ENV);

// The fixed-OTP switch. Harmless in UAT, a wide-open door on a live desk, so it is
// reported loudly whenever it is on and fatal if it is on in production.
if (String(E.OFS_OTP_TEST_MODE) === 'true') {
  if (prod) fail('OFS_OTP_TEST_MODE', 'true in production — refused at runtime; remove it');
  else flag('OFS_OTP_TEST_MODE', 'ON — every client signs in with ' + (E.OFS_OTP_TEST_CODE || '123456'));
} else {
  ok('OFS_OTP_TEST_MODE', 'off — real codes by email');
}
if (!E.OFS_SSO_SECRET) flag('OFS_SSO_SECRET', 'unset — staff cannot sign in to /desk from the portal');
const port = Number(E.PORT || 4011);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT', 'not a valid port');
else ok('PORT', String(port));
if ((E.HOST || '127.0.0.1') !== '127.0.0.1') {
  flag('HOST', 'not 127.0.0.1 — Node should bind to localhost with nginx in front');
} else ok('HOST', '127.0.0.1 (nginx in front)');

const origins = String(E.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!origins.length) flag('CORS_ORIGINS', 'empty — browser calls from another origin will be refused');
else if (origins.includes('*')) fail('CORS_ORIGINS', '"*" is not allowed; list exact origins');
else {
  const bad_ = origins.filter((o) => !/^https?:\/\//.test(o));
  if (bad_.length) fail('CORS_ORIGINS', 'not full origins: ' + bad_.join(', '));
  else {
    const insecure = origins.filter((o) => o.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(o));
    if (insecure.length) flag('CORS_ORIGINS', 'plain http origin(s): ' + insecure.join(', '));
    const placeholder = origins.filter((o) => /example\.com/i.test(o));
    if (placeholder.length) flag('CORS_ORIGINS', 'still the template placeholder: ' + placeholder.join(', '));
    else ok('CORS_ORIGINS', origins.join(', '));
  }
}

for (const k of ['APP_URL', 'PUBLIC_BASE_URL']) {
  if (E[k] && !/^https?:\/\//.test(E[k])) flag(k, 'should be a full URL');
  else if (E[k] && /example\.com/i.test(E[k])) flag(k, 'still the template placeholder');
}
if (!E.APP_URL && !E.PUBLIC_BASE_URL) flag('APP_URL', 'unset — email links will fall back to the UAT portal URL');

console.log('\nBusiness defaults');
ok('retail cap / HNI min', (E.OFS_RETAIL_CAP || '200000') + ' / ' + (E.OFS_HNI_MIN || '200000'));
ok('desk cut-off', (E.OFS_DAILY_CUTOFF || '15:15') + ' IST');
if (!/^\d{1,2}:\d{2}$/.test(E.OFS_DAILY_CUTOFF || '15:15')) fail('OFS_DAILY_CUTOFF', 'expected HH:MM');

console.log('');
if (bad) { console.log(bad + ' problem(s) must be fixed' + (warn ? ', ' + warn + ' to check' : '') + '\n'); process.exit(1); }
console.log(warn ? warn + ' item(s) worth checking, nothing fatal\n' : 'env looks complete\n');
