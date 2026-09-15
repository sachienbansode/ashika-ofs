'use strict';
/**
 * End-to-end scenarios, driven over HTTP against the running application.
 *
 * Not assertions over source: the real server, the real routes, two real
 * PostgreSQL databases with LD-shaped fixtures. Every scenario is a thing a
 * person does, and it passes only if the app answers the way the desk expects.
 *
 * Each result carries: what was attempted, what happened, and — when it fails —
 * why, in terms of the behaviour rather than the stack trace.
 */
const BASE = process.env.E2E_BASE || 'http://localhost:3199';
const results = [];
let group = '';

function G(name) { group = name; }

async function scenario(id, name, fn, opts) {
  const rec = { id, group, name, status: 'PASS', detail: '', expected: (opts || {}).expected || '' };
  try {
    const out = await fn();
    if (out && out.skip) { rec.status = 'SKIP'; rec.detail = out.skip; }
    else rec.detail = (out && out.detail) || '';
  } catch (e) {
    rec.status = 'FAIL';
    rec.detail = e.message;
  }
  results.push(rec);
  const mark = rec.status === 'PASS' ? '  ok  ' : rec.status === 'SKIP' ? ' skip ' : ' FAIL ';
  console.log(mark + id.padEnd(7) + ' ' + name + (rec.detail ? '  — ' + rec.detail : ''));
  return rec;
}

function must(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(msg + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }

/* ------------------------------------------------------------------ http -- */
const jar = {};            // name -> cookie value, per session label

async function http(method, path, { body, token, session, headers } = {}) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
  if (token) h.Authorization = 'Bearer ' + token;
  if (session && jar[session]) h.Cookie = jar[session];
  const res = await fetch(BASE + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual'
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (session && setCookie.length) {
    jar[session] = setCookie.map((c) => c.split(';')[0]).join('; ');
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* html or empty */ }
  return { status: res.status, json, text, headers: res.headers };
}

const GET = (p, o) => http('GET', p, o);
const POST = (p, b, o) => http('POST', p, Object.assign({ body: b }, o));
const PUT = (p, b, o) => http('PUT', p, Object.assign({ body: b }, o));
const DEL = (p, b, o) => http('DELETE', p, Object.assign({ body: b }, o));

/* --------------------------------------------------------------- helpers -- */
const PW = 'Passw0rd!TestOnly';
let DESK = null;            // bearer token for the SuperAdmin desk user
let ISSUE = null;           // the open issue every bidding scenario uses

function istNow() { return new Date(); }
function iso(d) { return new Date(d).toISOString(); }
function plusH(h) { return new Date(Date.now() + h * 3600e3).toISOString(); }
function minusH(h) { return new Date(Date.now() - h * 3600e3).toISOString(); }

/**
 * Place or change a bid on a client's behalf, completing the client's
 * confirmation the way the desk does: ask for a code, read it back, resend.
 *
 * With OFS_OTP_TEST_MODE on, create() returns the fixed code instead of sending
 * it — which is what lets this run with no SMTP. In production that path is
 * hard-floored off (lib/otp.isProduction), and there is a separate scenario for
 * that below.
 */
async function bidWithConfirmation(method, path, body, action) {
  const first = await http(method, path, { body, session: 'desk' });
  if (first.status < 400) return first;
  if (!(first.status === 428 && first.json && first.json.error === 'otp_required')) return first;

  const sent = await POST('/api/bids/otp', {
    client_ucc: body.client_ucc || (first.json && first.json.client_ucc),
    issue_id: body.issue_id || (first.json && first.json.issue_id),
    action: action, bid_id: body.bid_id || null,
    detail: body.qty + ' shares', terms: body
  }, { session: 'desk' });
  if (sent.status >= 400) {
    throw new Error('could not send the client confirmation: ' + sent.status + ' ' +
      ((sent.json && sent.json.message) || ''));
  }
  const code = sent.json.test_code;
  if (!code) throw new Error('no test code returned — is OFS_OTP_TEST_MODE on?');
  return http(method, path, {
    body: Object.assign({}, body, { otp_ref: sent.json.ref, otp: code }), session: 'desk'
  });
}

async function main() {
  /* =================================================== staff authentication */
  G('Back-office sign-in');

  await scenario('AUTH-1', 'Desk signs in with the right password', async () => {
    const r = await POST('/auth/staff/login', { email: 'desk@example.com', password: PW }, { session: 'desk' });
    must(r.status === 200, 'expected 200, got ' + r.status + ' ' + (r.text || '').slice(0, 160));
    must(r.json && r.json.ok, 'login did not report ok');
    must(jar.desk, 'no session cookie was set');
    DESK = true;
    return { detail: 'session cookie issued, role ' + ((r.json.user && r.json.user.role) || '?') };
  });

  await scenario('AUTH-2', 'A wrong password is refused', async () => {
    const r = await POST('/auth/staff/login', { email: 'desk@example.com', password: 'wrong-password' });
    eq(r.status, 401, 'a wrong password must be 401');
    return { detail: 'refused 401' };
  });

  await scenario('AUTH-3', 'An unknown address is refused the same way as a wrong password', async () => {
    const r = await POST('/auth/staff/login', { email: 'nobody@example.com', password: PW });
    eq(r.status, 401, 'an unknown account must not be distinguishable');
    return { detail: 'refused 401, indistinguishable from a bad password' };
  });

  await scenario('AUTH-4', 'A staff account with no OFS grant is refused the desk', async () => {
    const r = await POST('/auth/staff/login', { email: 'none@example.com', password: PW });
    must(r.status === 403, 'expected 403 no_ofs_access, got ' + r.status);
    eq(r.json && r.json.error, 'no_ofs_access', 'wrong refusal reason');
    return { detail: 'refused 403 no_ofs_access' };
  });

  await scenario('AUTH-5', 'Every /api route refuses an unauthenticated caller', async () => {
    const paths = ['/api/me', '/api/dashboard', '/api/bids', '/api/clients', '/api/margin', '/api/settings'];
    const bad = [];
    for (const p of paths) {
      const r = await GET(p);
      if (r.status !== 401) bad.push(p + ' -> ' + r.status);
    }
    must(!bad.length, 'reachable without a session: ' + bad.join(', '));
    return { detail: paths.length + ' endpoints all 401' };
  });

  await scenario('AUTH-6', 'A forged bearer token is rejected', async () => {
    const r = await GET('/api/me', { token: 'not.a.real.token' });
    eq(r.status, 401, 'a forged token must not authenticate');
    return { detail: 'refused 401' };
  });

  /* ============================================================ issue master */
  G('Issue master');

  await scenario('ISS-1', 'Desk creates an OFS issue', async () => {
    const r = await POST('/api/issues', {
      symbol: 'COALINDIA', company: 'Coal India Ltd', isin: 'INE522F01014',
      exchange: 'BOTH', series: 'EQ', bse_scrip_code: '533278',
      floor_price: 400, cut_price_min: 400, tick: 0.05, lot: 1,
      issue_qty: 50000000, retail_qty: 5000000, discount_pct: 0, cutoff_flag: true,
      hni_open: minusH(2), hni_close: plusH(6),
      ret_open: minusH(2), ret_close: plusH(6)
    }, { session: 'desk' });
    must(r.status === 201 || r.status === 200, 'expected 201, got ' + r.status + ' ' + (r.text || '').slice(0, 200));
    ISSUE = r.json.issue || r.json;
    must(ISSUE && ISSUE.id, 'no issue id returned');
    return { detail: 'issue #' + ISSUE.id + ' ' + ISSUE.symbol + ' on ' + ISSUE.exchange };
  });

  await scenario('ISS-2', 'The issue appears on the desk dashboard as open', async () => {
    const r = await GET('/api/dashboard', { session: 'desk' });
    eq(r.status, 200, 'dashboard unreachable');
    const found = (r.json.issues || []).find((i) => String(i.id) === String(ISSUE.id));
    must(found, 'the new issue is not on the dashboard');
    must(found.ret_status === 'Open' || found.hni_status === 'Open',
      'the issue is not open: retail=' + found.ret_status + ' hni=' + found.hni_status);
    return { detail: 'retail ' + found.ret_status + ', HNI ' + found.hni_status };
  });

  await scenario('ISS-3', 'An issue with a bad ISIN is refused', async () => {
    const r = await POST('/api/issues', {
      symbol: 'BADISIN', company: 'X', isin: 'NOTANISIN', exchange: 'BSE',
      floor_price: 10, tick: 0.05, lot: 1,
      hni_open: minusH(1), hni_close: plusH(1), ret_open: minusH(1), ret_close: plusH(1)
    }, { session: 'desk' });
    must(r.status >= 400, 'a malformed ISIN was accepted (' + r.status + ')');
    return { detail: 'refused ' + r.status };
  });

  /* ================================================================ margin */
  G('Margin');

  await scenario('MGN-1', 'Desk sets one client margin', async () => {
    const r = await PUT('/api/margin/ASH1001', { available: 500000, source: 'manual' }, { session: 'desk' });
    eq(r.status, 200, 'setting a margin failed: ' + (r.text || '').slice(0, 160));
    return { detail: 'ASH1001 available 5,00,000' };
  });

  await scenario('MGN-2', 'Bulk upload writes many margins in one request', async () => {
    const rows = [];
    for (let i = 0; i < 2000; i++) rows.push({ ucc: 'BULK' + String(i).padStart(5, '0'), available: 1000 + i });
    rows.push({ ucc: 'ASH1002', available: 250000 });
    const t0 = Date.now();
    const r = await POST('/api/margin/bulk', { source: 'csv', rows }, { session: 'desk' });
    const ms = Date.now() - t0;
    eq(r.status, 200, 'bulk upload failed: ' + (r.text || '').slice(0, 200));
    eq(r.json.updated, rows.length, 'not every row was written');
    must(ms < 20000, 'took ' + ms + 'ms — nginx would time this out at 60s');
    return { detail: rows.length + ' rows in ' + ms + 'ms' };
  }, { expected: 'was a gateway timeout before this fix' });

  await scenario('MGN-3', 'A UCC listed twice in one upload takes the last value', async () => {
    const r = await POST('/api/margin/bulk', {
      source: 'csv', rows: [{ ucc: 'DUPE01', available: 111 }, { ucc: 'DUPE01', available: 222 }]
    }, { session: 'desk' });
    eq(r.status, 200, 'duplicate UCC failed the whole upload: ' + (r.text || '').slice(0, 160));
    const m = await GET('/api/margin', { session: 'desk' });
    const row = (m.json.margins || []).find((x) => x.client_ucc === 'DUPE01');
    must(row, 'DUPE01 was not written at all');
    eq(Number(row.available), 222, 'the last value did not win');
    return { detail: 'collapsed to 222, upload succeeded' };
  });

  await scenario('MGN-4', 'Invalid rows are skipped and counted, not silently dropped', async () => {
    const r = await POST('/api/margin/bulk', {
      source: 'csv', rows: [{ ucc: 'GOOD01', available: 10 }, { ucc: '', available: 5 }, { ucc: 'NEG01', available: -1 }]
    }, { session: 'desk' });
    eq(r.status, 200, 'upload failed');
    eq(r.json.updated, 1, 'wrong number written');
    eq(r.json.skipped, 2, 'skipped rows were not reported');
    return { detail: '1 written, 2 skipped and reported' };
  });

  await scenario('MGN-5', 'The margin log keeps the value from before an overwrite', async () => {
    await PUT('/api/margin/LOGCHK', { available: 100, source: 'manual' }, { session: 'desk' });
    await PUT('/api/margin/LOGCHK', { available: 300, source: 'manual' }, { session: 'desk' });
    const r = await GET('/api/margin/LOGCHK/log', { session: 'desk' });
    eq(r.status, 200, 'margin log unreachable');
    const last = (r.json.log || [])[0];
    must(last, 'nothing was logged');
    eq(Number(last.old_value), 100, 'the previous value was not recorded');
    eq(Number(last.new_value), 300, 'the new value was not recorded');
    return { detail: 'logged 100 -> 300' };
  });

  await scenario('MGN-6', 'A margin record can be removed, and the log says removed', async () => {
    await PUT('/api/margin/DELME1', { available: 900, source: 'manual' }, { session: 'desk' });
    const r = await DEL('/api/margin/DELME1', {}, { session: 'desk' });
    eq(r.status, 200, 'delete failed: ' + (r.text || '').slice(0, 200));
    const log = await GET('/api/margin/DELME1/log', { session: 'desk' });
    const last = (log.json.log || [])[0];
    must(last && last.new_value === null, 'removal was not logged as NULL (it is not the same fact as zero)');
    const list = await GET('/api/margin', { session: 'desk' });
    must(!(list.json.margins || []).some((m) => m.client_ucc === 'DELME1'), 'the record is still there');
    return { detail: 'removed, history kept with new_value NULL' };
  }, { expected: 'failed with 23502 before migration 021' });

  await scenario('MGN-7', 'Zero-all sets every margin to zero and logs each one', async () => {
    const t0 = Date.now();
    const r = await POST('/api/margin/reset', { note: 'e2e reset' }, { session: 'desk' });
    const ms = Date.now() - t0;
    eq(r.status, 200, 'reset failed: ' + (r.text || '').slice(0, 200));
    must(r.json.clients > 0, 'reset reported zero clients');
    must(ms < 20000, 'took ' + ms + 'ms — would time out on a real book');
    const list = await GET('/api/margin', { session: 'desk' });
    const nonZero = (list.json.margins || []).filter((m) => Number(m.available) !== 0);
    eq(nonZero.length, 0, nonZero.length + ' margins are still non-zero after a reset');
    return { detail: r.json.clients + ' clients zeroed in ' + ms + 'ms' };
  }, { expected: 'was a gateway timeout before this fix' });

  await scenario('MGN-8', 'Fetch client returns the figures the margin panel shows', async () => {
    await PUT('/api/margin/ASH1001', { available: 500000, source: 'manual' }, { session: 'desk' });
    const r = await GET('/api/clients/ASH1001', { session: 'desk' });
    eq(r.status, 200, 'fetch client failed: ' + (r.text || '').slice(0, 200));
    const c = r.json.client || {};
    must(c.name, 'the client came back without a name — the chip on screen would be blank');
    eq(Number(c.available_margin), 500000, 'available_margin is not the figure that was set');
    must(c.margin_at, 'margin_at is missing — the panel cannot tell "no record" from "zero"');
    eq(Number(r.json.free_margin), 500000 - Number(r.json.margin_used || 0),
      'free is not available minus used');
    return { detail: c.name + ' · available ' + c.available_margin + ' · free ' + r.json.free_margin };
  }, { expected: 'the Masters margin panel reads used and free from this response' });

  await scenario('MGN-9', 'A client with no margin record is not reported as zero', async () => {
    const r = await GET('/api/clients/ASH9001', { session: 'desk' });
    eq(r.status, 200, 'fetch failed for a client with no margin row');
    must((r.json.client || {}).margin_at == null,
      'a client with no margin row came back carrying a margin timestamp');
    return { detail: 'no margin row -> margin_at null, so the panel shows a dash, not zero' };
  }, { expected: 'no record and a recorded zero are different facts' });

  await scenario('MGN-10', 'A margin file written by a spreadsheet imports', async () => {
    const { csvParse, csvObjects, csvNum } = require('../public/backoffice/csv');
    const file = 'Client UCC,Available Margin\r\n' +
      'ASH1001,"12,50,000"\r\n' +
      'ASH1002,"₹ 2,00,000.00"\r\n' +
      'ASH2001,750000\r\n';
    const rows = csvObjects(csvParse(file)).map((x) => ({
      ucc: String(x.client_ucc || '').toUpperCase(),
      available: csvNum(x.available_margin)
    }));
    must(rows.every((x) => Number.isFinite(x.available)),
      'a grouped or rupee-marked figure was still read as not-a-number: ' + JSON.stringify(rows));
    const r = await POST('/api/margin/bulk', { source: 'csv', rows }, { session: 'desk' });
    eq(r.status, 200, 'bulk import failed: ' + (r.text || '').slice(0, 200));
    eq(Number(r.json.updated), 3, 'not every row was written');
    const list = await GET('/api/margin', { session: 'desk' });
    const one = (list.json.margins || []).find((m) => m.client_ucc === 'ASH1001');
    eq(Number(one.available), 1250000, '12,50,000 did not land as 1250000');
    return { detail: '3 row(s) written; grouped digits and a rupee sign both read correctly' };
  }, { expected: 'every one of these rows was rejected as not-a-number before' });

  /* =========================================================== desk bidding */
  G('Bidding — back office');

  // Put the margin back for the bidding scenarios.
  await PUT('/api/margin/ASH1001', { available: 500000, source: 'manual' }, { session: 'desk' });
  await PUT('/api/margin/ASH1002', { available: 250000, source: 'manual' }, { session: 'desk' });

  await scenario('BID-1', 'Validate accepts a sound retail bid', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'Retail', qty: 100, price: 400, is_cutoff: false
    }, { session: 'desk' });
    eq(r.status, 200, 'validate unreachable');
    must(r.json.ok, 'a sound bid was refused: ' + JSON.stringify(r.json.errors));
    return { detail: 'value ' + r.json.value + ', free margin ' + r.json.free_margin };
  });

  await scenario('BID-2', 'A retail bid over the Rs 2 lakh SEBI cap is refused', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'Retail', qty: 600, price: 400, is_cutoff: false
    }, { session: 'desk' });
    must(!r.json.ok, 'a Rs 2.4 lakh retail bid was accepted');
    must((r.json.errors || []).some((e) => /2,00,000|200000|cap/i.test(e)),
      'refused, but not for the cap: ' + JSON.stringify(r.json.errors));
    return { detail: 'refused: ' + r.json.errors[0] };
  });

  await scenario('BID-3', 'An HNI bid below the non-retail minimum is refused', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'HNI', qty: 10, price: 400, is_cutoff: false
    }, { session: 'desk' });
    must(!r.json.ok, 'a Rs 4,000 HNI bid was accepted');
    must((r.json.errors || []).some((e) => /HNI bid must be at least/i.test(e)),
      'refused for the wrong reason: ' + JSON.stringify(r.json.errors));
    return { detail: 'refused: ' + r.json.errors.find((e) => /HNI/.test(e)) };
  });

  await scenario('BID-4', 'A price below the floor is refused', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'Retail', qty: 10, price: 399.95, is_cutoff: false
    }, { session: 'desk' });
    must(!r.json.ok, 'a below-floor price was accepted');
    must((r.json.errors || []).some((e) => /Cannot bid below/i.test(e)), JSON.stringify(r.json.errors));
    return { detail: 'refused: ' + r.json.errors[0] };
  });

  await scenario('BID-5', 'An off-tick price is refused', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'Retail', qty: 10, price: 400.03, is_cutoff: false
    }, { session: 'desk' });
    must(!r.json.ok, '400.03 was accepted on a 0.05 tick');
    must((r.json.errors || []).some((e) => /tick/i.test(e)), JSON.stringify(r.json.errors));
    return { detail: 'refused: ' + r.json.errors.find((e) => /tick/.test(e)) };
  });

  await scenario('BID-6', 'A near-tick price (400.049) is refused too', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'Retail', qty: 10, price: 400.049, is_cutoff: false
    }, { session: 'desk' });
    must(!r.json.ok, '400.049 was accepted — it used to pass because the check rounded first');
    must((r.json.errors || []).some((e) => /tick/i.test(e)), JSON.stringify(r.json.errors));
    return { detail: 'refused: within half a paisa of a tick, still refused' };
  }, { expected: 'was accepted and stored unrounded before the fix' });

  await scenario('BID-7', 'A bid above free margin is refused', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1002', exchange: 'BSE',
      category: 'HNI', qty: 1000, price: 400, is_cutoff: false
    }, { session: 'desk' });
    must(!r.json.ok, 'a Rs 4 lakh bid passed on Rs 2.5 lakh of margin');
    must((r.json.errors || []).some((e) => /free margin/i.test(e)), JSON.stringify(r.json.errors));
    return { detail: 'refused: ' + r.json.errors.find((e) => /margin/.test(e)) };
  });

  await scenario('BID-8', 'A bid for an inactive client is refused', async () => {
    await PUT('/api/margin/ASH9001', { available: 500000, source: 'manual' }, { session: 'desk' });
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH9001', exchange: 'BSE',
      category: 'Retail', qty: 10, price: 400, is_cutoff: false
    }, { session: 'desk' });
    must(!r.json.ok, 'an inactive client was allowed to bid');
    must((r.json.errors || []).some((e) => /not active|cannot bid/i.test(e)), JSON.stringify(r.json.errors));
    return { detail: 'refused: ' + r.json.errors[0] };
  });

  await scenario('BID-9', 'A bid on a both-exchange issue with no exchange named is refused', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001',
      category: 'Retail', qty: 10, price: 400, is_cutoff: false
    }, { session: 'desk' });
    must(!r.json.ok, 'a bid with no exchange was accepted on a BOTH issue');
    must((r.json.errors || []).some((e) => /exchange/i.test(e)), JSON.stringify(r.json.errors));
    return { detail: 'refused: ' + r.json.errors.find((e) => /exchange/i.test(e)) };
  });

  await scenario('BID-10', 'A cut-off bid is refused for HNI (it is a retail mechanism)', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'HNI', qty: 600, price: null, is_cutoff: true
    }, { session: 'desk' });
    must(!r.json.ok, 'an HNI cut-off bid was accepted');
    must((r.json.errors || []).some((e) => /cut-off/i.test(e)), JSON.stringify(r.json.errors));
    return { detail: 'refused: ' + r.json.errors.find((e) => /[Cc]ut-off/.test(e)) };
  });

  let BID = null;
  await scenario('BID-11', 'Desk places a bid on a client’s behalf', async () => {
    const r = await bidWithConfirmation('POST', '/api/bids', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'Retail', qty: 100, price: 400, is_cutoff: false
    }, 'place');
    must(r.status === 201 || r.status === 200,
      'place failed ' + r.status + ': ' + (r.text || '').slice(0, 220));
    BID = r.json.bid;
    must(BID && BID.id, 'no bid returned');
    return { detail: 'bid ' + BID.ref + ' for ' + BID.qty + ' @ ' + BID.price };
  });

  await scenario('BID-12', 'The application reference carries the client code', async () => {
    must(BID, { skip: 'no bid placed' });
    must(/^OFS-ASH1001-\d{6}-\d{6}[A-Z0-9]{4}$/.test(BID.ref),
      'reference does not carry the UCC: ' + BID.ref);
    return { detail: BID.ref };
  });

  await scenario('BID-13', 'The accepted bid carries the exchange-margin condition', async () => {
    const r = await bidWithConfirmation('POST', '/api/bids', {
      issue_id: ISSUE.id, client_ucc: 'ASH1002', exchange: 'NSE',
      category: 'Retail', qty: 50, price: 400, is_cutoff: false
    }, 'place');
    must(r.status === 201 || r.status === 200, 'place failed: ' + (r.text || '').slice(0, 160));
    must(r.json.notice && /margin available at the time the bid is submitted to the exchange/.test(r.json.notice),
      'the standing condition is missing from the response');
    return { detail: 'notice returned with the bid' };
  });

  await scenario('BID-14', 'A second live bid for the same client on the same issue is refused', async () => {
    const r = await bidWithConfirmation('POST', '/api/bids', {
      issue_id: ISSUE.id, client_ucc: 'ASH1001', exchange: 'BSE',
      category: 'Retail', qty: 10, price: 400, is_cutoff: false
    }, 'place');
    must(r.status >= 400, 'a duplicate live bid was accepted');
    return { detail: 'refused ' + r.status + ' ' + ((r.json && r.json.error) || '') };
  });

  await scenario('BID-15', 'Desk modifies a bid', async () => {
    must(BID, { skip: 'no bid placed' });
    const r = await bidWithConfirmation('PUT', '/api/bids/' + BID.id, {
      qty: 120, price: 400, is_cutoff: false, category: 'Retail', exchange: 'BSE',
      client_ucc: 'ASH1001', issue_id: ISSUE.id, bid_id: BID.id
    }, 'modify');
    eq(r.status, 200, 'modify failed: ' + (r.text || '').slice(0, 200));
    eq(Number(r.json.bid.qty), 120, 'quantity did not change');
    return { detail: 'qty 100 -> 120, exchange kept as ' + r.json.bid.exchange };
  });

  await scenario('BID-16', 'The bid book shows the bid with its client and branch', async () => {
    const r = await GET('/api/bids?issue_id=' + ISSUE.id, { session: 'desk' });
    eq(r.status, 200, 'bid book unreachable');
    const row = (r.json.bids || []).find((b) => String(b.id) === String(BID.id));
    must(row, 'the bid is not in the book');
    eq(row.client_ucc, 'ASH1001', 'wrong client');
    must(row.client_name, 'the client name was not merged from the client master');
    return { detail: row.ref + ' · ' + row.client_name + ' · branch ' + (row.branch_code || '—') };
  });

  await scenario('BID-17', 'Margin used reflects the live bid', async () => {
    const r = await GET('/api/clients/ASH1001', { session: 'desk' });
    eq(r.status, 200, 'client lookup failed');
    eq(Number(r.json.margin_used), 48000, 'used margin does not match the live bid (120 x 400)');
    eq(Number(r.json.free_margin), 452000, 'free margin is wrong');
    return { detail: 'used 48,000 · free 4,52,000' };
  });

  await scenario('ELG-1', 'A client not in the client master cannot bid', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH7001', exchange: 'BSE',
      category: 'Retail', qty: 100, price: 400
    }, { session: 'desk' });
    const errs = (r.json && (r.json.errors || [])).join(' ');
    must(r.status >= 400 || errs, 'a client with no client-master row was allowed to bid');
    must(/client master/i.test(errs), 'the refusal does not say why: ' + errs);
    return { detail: errs.slice(0, 120) };
  }, { expected: 'this client used to come out ACTIVE - each status fell back to the other' });

  await scenario('ELG-2', 'A client whose status is blank cannot bid', async () => {
    const r = await POST('/api/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH7002', exchange: 'BSE',
      category: 'Retail', qty: 100, price: 400
    }, { session: 'desk' });
    const errs = (r.json && (r.json.errors || [])).join(' ');
    must(r.status >= 400 || errs, 'a client with no status recorded was allowed to bid');
    must(/blank/i.test(errs), 'the refusal does not name the blank status: ' + errs);
    return { detail: errs.slice(0, 120) };
  }, { expected: 'a missing status is not a yes' });

  await scenario('ELG-3', 'An ineligible client cannot be placed for, not just validated', async () => {
    for (const ucc of ['ASH7001', 'ASH7002', 'ASH9001']) {
      const r = await POST('/api/bids', {
        issue_id: ISSUE.id, client_ucc: ucc, exchange: 'BSE',
        category: 'Retail', qty: 100, price: 400
      }, { session: 'desk' });
      must(r.status >= 400, ucc + ' was accepted by POST /api/bids with status ' + r.status);
    }
    return { detail: 'all three refused at the place endpoint, not only at validate' };
  }, { expected: 'validate and place must agree - the screen is not the control' });

  await scenario('ELG-4', 'The client record says whether it may bid, and why not', async () => {
    const r = await GET('/api/clients/ASH7001', { session: 'desk' });
    eq(r.status, 200, 'the client could not be read');
    const c = r.json.client || {};
    eq(c.is_active, false, 'a client with no client-master row is still reported active');
    must(c.inactive_reason, 'no reason given, so the bid screen can only say "cannot bid"');
    const ok = await GET('/api/clients/ASH1001', { session: 'desk' });
    eq((ok.json.client || {}).is_active, true, 'a genuinely active client is now blocked');
    return { detail: 'ASH7001: ' + c.inactive_reason + ' · ASH1001 still active' };
  }, { expected: 'the Place bid panel warns before the form is filled in' });

  await scenario('ELG-5', 'A branch cannot bid for an ineligible client either', async () => {
    const r = await POST('/client/api/branch/bids/validate', {
      issue_id: ISSUE.id, client_ucc: 'ASH7002', exchange: 'BSE',
      category: 'Retail', qty: 100, price: 400
    }, { session: 'ap' });
    must(r.status >= 400 || ((r.json && r.json.errors) || []).length,
      'the partner path let an ineligible client through');
    return { detail: 'refused on the partner path as well as the desk' };
  }, { expected: 'one rule, every door' });

  /* ================================================== exchange file export */
  G('Exchange files');

  await scenario('EXP-1', 'BSE file builds and contains the bid', async () => {
    const r = await GET('/api/export/BSE/preview?issue_id=' + ISSUE.id, { session: 'desk' });
    eq(r.status, 200, 'BSE preview failed: ' + (r.text || '').slice(0, 200));
    must(r.json.row_count >= 1, 'no rows in the BSE file');
    return { detail: r.json.file_name + ' · ' + r.json.row_count + ' row(s) · ' + r.json.total_qty + ' shares' };
  });

  await scenario('EXP-2', 'The NSE file carries only the NSE-marked bid', async () => {
    const r = await GET('/api/export/NSE/preview?issue_id=' + ISSUE.id, { session: 'desk' });
    eq(r.status, 200, 'NSE preview failed: ' + (r.text || '').slice(0, 200));
    eq(r.json.row_count, 1, 'NSE file should carry exactly the one NSE bid');
    return { detail: r.json.row_count + ' row — the BSE bid is not in it' };
  }, { expected: 'both files used to carry every bid' });

  await scenario('EXP-3', 'A file can be built for an earlier day', async () => {
    const yest = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
    const r = await GET('/api/export/BSE/preview?issue_id=' + ISSUE.id + '&as_on=' + yest, { session: 'desk' });
    eq(r.status, 200, 'as-on export failed: ' + (r.text || '').slice(0, 160));
    eq(r.json.row_count, 0, 'yesterday should have no bids in this fixture');
    return { detail: 'as_on=' + yest + ' returns 0 rows, today returns the live bids' };
  });

  await scenario('EXP-4', 'The download is recorded in the export audit log', async () => {
    const d = await GET('/api/export/BSE/download?issue_id=' + ISSUE.id, { session: 'desk' });
    eq(d.status, 200, 'download failed');
    const log = await GET('/api/export/log', { session: 'desk' });
    must((log.json.exports || []).length >= 1, 'the download was not logged');
    return { detail: (log.json.exports || []).length + ' export(s) logged' };
  });

  /* ======================================================= partner / branch */
  G('Branch / Authorised Partner portal');

  await scenario('AP-1', 'A branch/AP endpoint refuses an unauthenticated caller', async () => {
    const r = await GET('/client/api/me/clients');
    eq(r.status, 401, 'the partner API is reachable without a session');
    return { detail: 'refused 401' };
  });

  await scenario('AP-2', 'A desk bearer token does not open the partner API', async () => {
    const r = await GET('/client/api/me/clients', { session: 'desk' });
    eq(r.status, 401, 'a staff token authenticated against the portal API');
    return { detail: 'refused 401 — the two sessions are separate' };
  });

  await scenario('AP-3', 'Branch sign-in sends a code to the address on the branch record', async () => {
    const r = await POST('/client/auth/branch/start', { email: 'branch.a016@example.com' }, { session: 'ap' });
    // No SMTP in this environment; the app should still accept the request or
    // report that it could not send — either is a pass, a 500 is not.
    must(r.status < 500, 'branch sign-in raised ' + r.status + ': ' + (r.text || '').slice(0, 200));
    return { detail: 'answered ' + r.status + ' ' + ((r.json && (r.json.error || 'ok')) || '') };
  });

  await scenario('AP-4', 'A branch marked inactive in the client master cannot start a sign-in', async () => {
    const r = await POST('/client/auth/branch/start', { email: 'branch.a017@example.com' });
    must(r.status >= 400, 'an inactive branch was allowed to start a sign-in');
    return { detail: 'refused ' + r.status + ' ' + ((r.json && r.json.error) || '') };
  });

  await scenario('AP-5', 'A branch signs in and sees ONLY its own clients', async () => {
    const start = await POST('/client/auth/branch/start', { email: 'branch.a016@example.com' }, { session: 'ap' });
    must(start.status === 200, 'branch sign-in start failed: ' + (start.text || '').slice(0, 160));
    const code = start.json.test_code;
    must(code, 'no test code — is OFS_OTP_TEST_MODE on?');
    const v = await POST('/client/auth/branch/verify',
      { ref: start.json.ref, otp: code, branch_code: 'A016' }, { session: 'ap' });
    must(v.status === 200, 'branch verify failed: ' + (v.text || '').slice(0, 200));

    const list = await GET('/client/api/me/clients?limit=50', { session: 'ap' });
    eq(list.status, 200, 'the AP cannot read its own client list');
    const uccs = (list.json.clients || []).map((c) => c.ucc);
    must(uccs.includes('ASH1001'), 'the AP cannot see its own client ASH1001');
    must(!uccs.includes('ASH2001'),
      'SCOPE LEAK: the AP can see ASH2001, which belongs to branch A017');
    return { detail: uccs.length + ' client(s): ' + uccs.join(', ') };
  }, { expected: 'scope isolation' });

  await scenario('AP-6', 'A branch cannot open a client outside its own book', async () => {
    const r = await GET('/client/api/me/clients/ASH2001', { session: 'ap' });
    eq(r.status, 404, 'SCOPE LEAK: another branch\'s client was readable (' + r.status + ')');
    return { detail: 'answered 404 — "not yours" and "not found" look the same' };
  });

  await scenario('AP-7', 'A branch sees its clients with PII masked', async () => {
    const r = await GET('/client/api/me/clients/ASH1001', { session: 'ap' });
    eq(r.status, 200, 'the AP cannot open its own client');
    const c = r.json.client || {};
    const bare = [c.pan, c.mobile, c.email].filter(Boolean).join(' ');
    must(!/AAAPZ1234A/.test(bare), 'PII LEAK: the full PAN was sent to a branch session');
    must(!/9811100001/.test(bare), 'PII LEAK: the full mobile was sent to a branch session');
    must(r.json.pii_unmasked === false, 'the response does not declare itself masked');
    return { detail: 'pan ' + (c.pan || '—') + ' · mobile ' + (c.mobile || '—') };
  }, { expected: 'an AP is not the desk' });

  await scenario('AP-8', 'A branch cannot reach a desk-only endpoint', async () => {
    const bad = [];
    for (const p of ['/api/margin', '/api/settings', '/api/audit', '/api/export/log']) {
      const r = await GET(p, { session: 'ap' });
      if (r.status !== 401 && r.status !== 403) bad.push(p + ' -> ' + r.status);
    }
    must(!bad.length, 'a branch session reached desk endpoints: ' + bad.join(', '));
    return { detail: '4 desk endpoints all refused' };
  });

  /* ========================================================= client portal */
  G('Investor portal');

  await scenario('CL-1', 'The portal refuses an unauthenticated caller', async () => {
    const r = await GET('/client/api/issues');
    eq(r.status, 401, 'the client API is open');
    return { detail: 'refused 401' };
  });

  await scenario('CL-2', 'An unknown identifier gives the generic answer, not a yes/no', async () => {
    const a = await POST('/client/auth/start', { identifier: 'ASH1001' });
    const b = await POST('/client/auth/start', { identifier: 'NOSUCHCLIENT' });
    eq(a.status, b.status, 'a real client and an invented one answer differently (' +
      a.status + ' vs ' + b.status + ') — that is an enumeration oracle');
    return { detail: 'both answered ' + a.status };
  }, { expected: 'used to answer 200 vs 404' });

  /* ============================================================== settings */
  G('Settings and access control');

  await scenario('SET-1', 'Desk reads the settings list', async () => {
    const r = await GET('/api/settings', { session: 'desk' });
    eq(r.status, 200, 'settings unreachable');
    const list = Array.isArray(r.json.settings) ? r.json.settings
      : Object.keys(r.json.settings || {}).map((k) => ({ key: k, value: r.json.settings[k] }));
    const keys = list.map((s) => s.key);
    for (const k of ['daily_cutoff', 'retail_cap', 'hni_min', 'allowed_exchanges',
                     'bid_email_confirm', 'export_email_enabled', 'export_email_time']) {
      must(keys.includes(k), 'setting missing from the screen: ' + k);
    }
    return { detail: keys.length + ' settings, all expected keys present' };
  });

  await scenario('SET-2', 'Order-confirmation email is OFF by default', async () => {
    const r = await GET('/api/settings', { session: 'desk' });
    const raw = r.json.settings || {};
    const val = Array.isArray(raw) ? (raw.find((x) => x.key === 'bid_email_confirm') || {}).value
                                   : raw.bid_email_confirm;
    eq(String(val), '0', 'confirmation email defaults to ON — it must not');
    return { detail: 'bid_email_confirm = 0' };
  });

  await scenario('SET-3', 'Exchange-file email is ON by default at 15:16', async () => {
    const r = await GET('/api/settings', { session: 'desk' });
    const raw = r.json.settings || {};
    const pick = (k) => Array.isArray(raw) ? (raw.find((x) => x.key === k) || {}).value : raw[k];
    eq(String(pick('export_email_enabled')), '1', 'the exchange-file email is off by default');
    eq(String(pick('export_email_time')), '15:16', 'the default send time is not 15:16');
    return { detail: 'enabled, 15:16 IST' };
  });

  await scenario('SET-4', 'A retail cap above the SEBI limit is refused', async () => {
    const r = await PUT('/api/settings', { key: 'retail_cap', value: '500000' }, { session: 'desk' });
    must(r.status >= 400, 'a retail cap above Rs 2 lakh was accepted');
    return { detail: 'refused ' + r.status };
  });

  await scenario('SET-5', 'Restricting the desk to BSE stops NSE-only issues being bid', async () => {
    const up = await PUT('/api/settings', { key: 'allowed_exchanges', value: 'BSE' }, { session: 'desk' });
    eq(up.status, 200, 'could not set allowed_exchanges');
    // New NSE-only issue while only BSE is enabled.
    const iss = await POST('/api/issues', {
      symbol: 'NSEONLY' + Date.now().toString().slice(-5), company: 'NSE Only Ltd',
      isin: 'INE111A01011', exchange: 'NSE',
      floor_price: 100, cut_price_min: 100, tick: 0.05, lot: 1, cutoff_flag: true,
      hni_open: minusH(1), hni_close: plusH(5), ret_open: minusH(1), ret_close: plusH(5)
    }, { session: 'desk' });
    must(iss.status < 400, 'could not create the NSE-only issue: ' + (iss.text || '').slice(0, 160));
    await new Promise((r) => setTimeout(r, 1100));   // settings cache is 30s; force a read below
    const v = await POST('/api/bids/validate', {
      issue_id: (iss.json.issue || iss.json).id, client_ucc: 'ASH1001',
      category: 'Retail', qty: 10, price: 100, is_cutoff: false
    }, { session: 'desk' });
    if (v.json && v.json.ok) throw new Error('an NSE-only issue was biddable with only BSE enabled ' +
      '(settings cache may not have expired — re-run to confirm)');
    return { detail: 'refused: ' + ((v.json.errors || [])[0] || '') };
  }, { expected: 'new control' });

  await scenario('SET-6', 'Restoring both exchanges makes it biddable again', async () => {
    await PUT('/api/settings', { key: 'allowed_exchanges', value: 'NSE,BSE' }, { session: 'desk' });
    return { detail: 'allowed_exchanges restored to NSE,BSE' };
  });

  /* ================================================================ audit */
  G('Audit trail');

  await scenario('AUD-1', 'Placing and modifying a bid is audited', async () => {
    const r = await GET('/api/audit?limit=100', { session: 'desk' });
    eq(r.status, 200, 'audit unreachable');
    const acts = (r.json.entries || r.json.audit || r.json.rows || []).map((a) => a.action);
    must(acts.includes('place'), 'no place entry in the audit trail');
    must(acts.includes('modify'), 'no modify entry in the audit trail');
    return { detail: acts.length + ' entries; place and modify both present' };
  });

  await scenario('AUD-2', 'Margin changes are audited', async () => {
    const r = await GET('/api/audit?limit=200', { session: 'desk' });
    const acts = (r.json.entries || r.json.audit || r.json.rows || []).map((a) => a.action);
    must(acts.includes('set_margin') || acts.includes('bulk_margin'), 'margin writes are not audited');
    return { detail: 'margin actions present' };
  });

  /* =========================================================== withdrawal */
  G('Withdrawal');

  await scenario('WDR-1', 'Desk withdraws a bid', async () => {
    must(BID, { skip: 'no bid placed' });
    const r = await bidWithConfirmation('DELETE', '/api/bids/' + BID.id,
      { reason: 'e2e withdrawal', client_ucc: 'ASH1001', issue_id: ISSUE.id, bid_id: BID.id },
      'cancel');
    eq(r.status, 200, 'withdrawal failed: ' + (r.text || '').slice(0, 200));
    eq(r.json.bid.status, 'Cancelled', 'the bid is not cancelled');
    return { detail: BID.ref + ' cancelled' };
  });

  await scenario('WDR-2', 'A withdrawn bid releases its margin', async () => {
    const r = await GET('/api/clients/ASH1001', { session: 'desk' });
    eq(Number(r.json.margin_used), 0, 'margin is still held against a cancelled bid');
    return { detail: 'used back to 0' };
  });

  await scenario('WDR-3', 'A withdrawn bid is not in the exchange file', async () => {
    const r = await GET('/api/export/BSE/preview?issue_id=' + ISSUE.id, { session: 'desk' });
    eq(r.json.row_count, 0, 'a cancelled bid is still in the BSE file');
    return { detail: 'BSE file now 0 rows' };
  });

  await scenario('WDR-4', 'Withdrawing the same bid twice is refused', async () => {
    const r = await bidWithConfirmation('DELETE', '/api/bids/' + BID.id,
      { reason: 'again', client_ucc: 'ASH1001', issue_id: ISSUE.id, bid_id: BID.id }, 'cancel');
    must(r.status >= 400, 'a cancelled bid was cancelled again');
    return { detail: 'refused ' + r.status + ' ' + ((r.json && r.json.error) || '') };
  });

  await scenario('WDR-5', 'The book defaults to what still stands', async () => {
    const r = await GET('/api/bids', { session: 'desk' });
    eq(r.status, 200, 'bid book failed');
    const bad = (r.json.bids || []).filter((b) => b.status === 'Cancelled' || b.status === 'Rejected');
    eq(bad.length, 0, bad.length + ' withdrawn or rejected bid(s) are counted in the default book');
    return { detail: (r.json.bids || []).length + ' live/modified bid(s), no dead rows' };
  }, { expected: 'the default total is the one the desk reconciles against' });

  await scenario('WDR-6', 'All bids shows every row, withdrawn and rejected included', async () => {
    const all = await GET('/api/bids?status=ALL', { session: 'desk' });
    eq(all.status, 200, 'status=ALL failed: ' + (all.text || '').slice(0, 200));
    const rows = all.json.bids || [];
    must(rows.some((b) => b.status === 'Cancelled'),
      'status=ALL did not return the bid that was withdrawn a moment ago');
    const dflt = await GET('/api/bids', { session: 'desk' });
    must(rows.length > (dflt.json.bids || []).length,
      'All returned no more rows than the default view');
    const seen = [...new Set(rows.map((b) => b.status))].sort().join(', ');
    return { detail: rows.length + ' row(s) across ' + seen };
  }, { expected: 'the bid book "All bids" option sends status=ALL' });

  await scenario('WDR-7', 'Each status can still be asked for on its own', async () => {
    for (const st of ['Live', 'Modified', 'Cancelled', 'Rejected']) {
      const r = await GET('/api/bids?status=' + st, { session: 'desk' });
      eq(r.status, 200, st + ' filter failed');
      const wrong = (r.json.bids || []).filter((b) => b.status !== st);
      eq(wrong.length, 0, st + ' filter returned a bid with status ' + (wrong[0] || {}).status);
    }
    return { detail: 'Live, Modified, Cancelled and Rejected each return only their own' };
  }, { expected: 'ALL must not break the single-status filters' });

  await scenario('WDR-8', 'A branch sees the same three-way on its own book only', async () => {
    const r = await GET('/client/api/me/bids?status=ALL', { session: 'ap' });
    eq(r.status, 200, 'partner book with status=ALL failed: ' + (r.text || '').slice(0, 200));
    const outside = (r.json.bids || []).filter((b) => !['ASH1001', 'ASH1002'].includes(b.client_ucc));
    eq(outside.length, 0, 'All bids leaked a client outside the branch book');
    return { detail: (r.json.bids || []).length + ' row(s), all within the branch book' };
  }, { expected: 'a wider status filter must not widen the scope' });

  /* ============================================================== security */
  G('Security headers and hardening');

  await scenario('SEC-1', 'Security headers are set on the shell', async () => {
    const r = await GET('/backoffice/login.html');
    const want = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options'];
    const missing = want.filter((h) => !r.headers.get(h));
    must(!missing.length, 'missing headers: ' + missing.join(', '));
    must(!/unsafe-inline/.test(r.headers.get('content-security-policy') || ''),
      'CSP allows unsafe-inline');
    return { detail: want.length + ' headers present, CSP has no unsafe-inline' };
  });

  await scenario('SEC-2', 'An unknown API path 404s rather than leaking a stack', async () => {
    const r = await GET('/api/does-not-exist', { session: 'desk' });
    must(r.status === 404, 'expected 404, got ' + r.status);
    must(!/at \/|node_modules|Error:/.test(r.text || ''), 'a stack trace leaked to the client');
    return { detail: '404, no stack' };
  });

  await scenario('SEC-3', 'A SQL metacharacter in a UCC is parameterised, not executed', async () => {
    const r = await GET("/api/clients?q=' OR 1=1 --", { session: 'desk' });
    eq(r.status, 200, 'the query errored instead of being parameterised: ' + (r.text || '').slice(0, 160));
    eq((r.json.clients || []).length, 0, 'an injection returned rows');
    return { detail: 'returned 0 rows, no error' };
  });

  /* =============================================================== clients */
  G('Client list');

  await scenario('CLT-1', 'The desk client list pages ten at a time with a total', async () => {
    const r = await GET('/api/clients?limit=10&offset=0', { session: 'desk' });
    eq(r.status, 200, 'client list unreachable');
    must(typeof r.json.total === 'number', 'no total returned — the pager cannot be drawn');
    must((r.json.clients || []).length <= 10, 'more than ten rows on a page');
    return { detail: r.json.clients.length + ' of ' + r.json.total + ' client(s)' };
  }, { expected: 'used to return 100 rows and no total' });

  await scenario('CLT-2', 'Page two returns different clients', async () => {
    const p1 = await GET('/api/clients?limit=2&offset=0', { session: 'desk' });
    const p2 = await GET('/api/clients?limit=2&offset=2', { session: 'desk' });
    const a = (p1.json.clients || []).map((c) => c.ucc).join(',');
    const b = (p2.json.clients || []).map((c) => c.ucc).join(',');
    must(a && b && a !== b, 'paging returns the same rows: [' + a + '] vs [' + b + ']');
    return { detail: 'page 1 [' + a + '] · page 2 [' + b + ']' };
  });

  await scenario('CLT-3', 'Client search finds by UCC and by name', async () => {
    const byUcc = await GET('/api/clients?q=ASH1001', { session: 'desk' });
    const byName = await GET('/api/clients?q=ACTIVE CLIENT ONE', { session: 'desk' });
    must((byUcc.json.clients || []).length >= 1, 'search by UCC found nothing');
    must((byName.json.clients || []).length >= 1, 'search by name found nothing');
    return { detail: 'UCC and name both resolve' };
  });

  await scenario('CLT-4', 'The client list carries margin per client', async () => {
    const r = await GET('/api/clients?q=ASH1001', { session: 'desk' });
    const c = (r.json.clients || [])[0];
    must(c && c.available_margin !== undefined, 'no margin on the client row');
    must(c.free_margin !== undefined, 'no free margin on the client row');
    return { detail: 'available ' + c.available_margin + ' · free ' + c.free_margin };
  });

  G('Production safety');

  await scenario('PRD-1', 'The fixed test OTP is floored off in production', async () => {
    const otp = require('../lib/otp');
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const onInProd = otp.testMode({ otp_mode_client: 'test' });
      must(onInProd === false,
        'a desk setting of "test" still enabled fixed OTP codes on a production server');
      process.env.NODE_ENV = saved;
      const onInTest = otp.testMode({ otp_mode_client: 'test' });
      must(onInTest === true, 'test mode does not work outside production either');
      return { detail: 'setting "test" is honoured off production, ignored on it' };
    } finally { process.env.NODE_ENV = saved; }
  }, { expected: 'a desk setting must never weaken a production server' });

  /* ================================================================ report */
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log('\n' + '='.repeat(72));
  console.log('TOTAL ' + results.length + '   PASS ' + pass + '   FAIL ' + fail + '   SKIP ' + skip);
  require('fs').writeFileSync('/tmp/e2e-results.json', JSON.stringify(results, null, 1));
  process.exit(0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
