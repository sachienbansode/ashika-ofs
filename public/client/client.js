'use strict';
/* Client journey: mobile + email -> one-time code -> bid.
   CSP-safe: no inline script, no external CDN. */

var $  = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

var S = { ref: null, choose: null, resendAt: 0, timer: null, tab: 'issues', client: null };

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function inr(n, d) {
  d = d == null ? 2 : d;
  return (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function rupee(n, d) { return '₹' + inr(n, d); }
function dt(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-IN',
    { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
function hms(ms) {
  if (ms <= 0) return '00:00:00';
  var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  var p = function (x) { return String(x).padStart(2, '0'); };
  return p(h) + ':' + p(m) + ':' + p(s % 60);
}
function initials(n) {
  return String(n || '?').trim().split(/\s+/).slice(0, 2)
    .map(function (w) { return w[0]; }).join('').toUpperCase();
}
function toast(title, msg, kind) {
  var b = document.createElement('div');
  if (kind) b.className = kind;
  b.innerHTML = '<b>' + esc(title) + '</b><p>' + esc(msg || '') + '</p>';
  $('#toast').appendChild(b);
  setTimeout(function () { b.remove(); }, 6000);
}

async function api(path, opts) {
  opts = opts || {};
  var res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  var text = await res.text();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
  if (!res.ok) { var err = new Error((json && json.message) || (json && json.error) || res.statusText);
                 err.status = res.status; err.body = json; throw err; }
  return json;
}

/* ---------------- step chrome ---------------- */
function setStep(n) {
  [1, 2, 3].forEach(function (i) {
    var el = $('#stp' + i);
    el.classList.toggle('on', i === n);
    el.classList.toggle('done', i < n);
  });
}
function showPane(which) {
  ['Details', 'Otp', 'Choose'].forEach(function (p) {
    $('#pane' + p).classList.toggle('hide', p.toLowerCase() !== which);
  });
}

/* ---------------- step 1: details ---------------- */
var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** One field takes either a 10-digit mobile or an email address. */
function identifierKind() {
  var v = $('#idInput').value.trim();
  if (v.indexOf('@') >= 0) return EMAIL_RE.test(v) ? 'email' : null;
  return v.replace(/\D/g, '').length === 10 ? 'mobile' : null;
}

/**
 * Validity is shown as it is typed rather than on submit: a tick when a field is
 * well-formed, and Send stays disabled until both are. Nobody should press a button
 * only to be told their mobile is nine digits.
 */
function refreshDetails() {
  var el = $('#idInput');
  var kind = identifierKind();
  var typed = el.value.trim().length > 0;

  el.closest('.field').classList.toggle('valid', !!kind);
  // Only complain once the field has been left, never mid-typing.
  el.setAttribute('aria-invalid', String(!kind && typed && document.activeElement !== el));

  // Say which one was recognised, so a typo in an email is obvious immediately.
  var hint = $('#detailsHint');
  if (!hint.classList.contains('bad')) {
    hint.textContent = kind === 'mobile' ? 'Recognised as a mobile number.'
      : kind === 'email' ? 'Recognised as an email address.'
      : 'Whichever you use, it must be the one registered with your Ashika account.';
  }
  $('#sendBtn').disabled = !kind;
}

function busy(sel, on, label) {
  var b = $(sel);
  b.classList.toggle('busy', on);
  b.setAttribute('aria-busy', String(on));
  b.disabled = on;
  if (label) b.querySelector('.lbl').textContent = label;
}

async function sendCode() {
  var identifier = $('#idInput').value.trim();
  var hint = $('#detailsHint');

  if (!identifierKind()) {
    hint.className = 'hint bad';
    hint.textContent = 'Enter your registered 10-digit mobile number, or your registered email address.';
    $('#idInput').setAttribute('aria-invalid', 'true'); $('#idInput').focus(); return;
  }
  hint.className = 'hint';

  busy('#sendBtn', true, 'Sending…');
  try {
    var r = await api('/client/auth/start', { method: 'POST', body: { identifier: identifier } });
    S.ref = r.ref || null;

    // The server answers the same way whether or not the details matched, so the
    // page must not imply an account exists either.
    $('#otpSentTo').textContent = r.sent_to ? ('Sent to ' + r.sent_to)
      : 'Check your registered email and mobile';
    $('#otpHint').className = 'hint';
    $('#otpHint').textContent = r.message || '';

    $('#demoOtp').innerHTML = r.test_mode
      ? '<div class="demo-otp"><span>Test mode — nothing was sent. Code:</span><b>' +
        esc(r.test_code) + '</b></div>'
      : '';
    $('#testBanner').classList.toggle('hide', !r.test_mode);

    S.resendAt = Date.now() + (r.resend_after_s || 60) * 1000;
    buildOtpBoxes();
    setStep(2); showPane('otp');
    var first = $('#otpBox input'); if (first) first.focus();
  } catch (e) {
    hint.className = 'hint bad';
    hint.textContent = e.message || 'Could not send a code just now.';
    if (e.body && e.body.retry_after_s) S.resendAt = Date.now() + e.body.retry_after_s * 1000;
  } finally {
    busy('#sendBtn', false, 'Send code');
    refreshDetails();
  }
}

/* ---------------- step 2: the code ---------------- */
function buildOtpBoxes() {
  var box = $('#otpBox');
  box.innerHTML = '';
  for (var i = 0; i < 6; i++) {
    var el = document.createElement('input');
    el.type = 'text'; el.inputMode = 'numeric'; el.maxLength = 1; el.autocomplete = 'one-time-code';
    box.appendChild(el);
  }
  var inputs = $$('#otpBox input');
  inputs.forEach(function (el, ix) {
    el.addEventListener('input', function () {
      el.value = el.value.replace(/\D/g, '').slice(0, 1);
      el.classList.toggle('filled', !!el.value);
      if (el.value && ix < 5) inputs[ix + 1].focus();
      if (otpValue().length === 6) verifyCode();
    });
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Backspace' && !el.value && ix > 0) inputs[ix - 1].focus();
    });
    // Paste the whole code into any box and it distributes.
    el.addEventListener('paste', function (ev) {
      var t = (ev.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      if (!t) return;
      ev.preventDefault();
      inputs.forEach(function (b, i) { b.value = t[i] || ''; b.classList.toggle('filled', !!b.value); });
      (inputs[Math.min(t.length, 5)] || inputs[5]).focus();
      if (t.length === 6) verifyCode();
    });
  });
}
function otpValue() { return $$('#otpBox input').map(function (e) { return e.value; }).join(''); }

function otpError(msg) {
  $('#otpHint').className = 'hint bad';
  $('#otpHint').textContent = msg;
  $$('#otpBox input').forEach(function (e) { e.value = ''; e.classList.remove('filled'); });
  var f = $('#otpBox input'); if (f) f.focus();
}

async function verifyCode() {
  var code = otpValue();
  if (code.length !== 6) { otpError('Enter all six digits.'); return; }
  busy('#verifyBtn', true, 'Verifying…');
  try {
    var r = await api('/client/auth/verify', { method: 'POST', body: { ref: S.ref, otp: code } });
    if (r.choose) { S.choose = r.choose; renderAccounts(r.accounts); return; }
    S.client = r.client;
    enterApp();
  } catch (e) {
    var left = e.body && e.body.attempts_left;
    otpError(e.message + (left != null ? ' ' + left + ' attempt(s) left.' : ''));
  } finally {
    busy('#verifyBtn', false, 'Verify & continue');
  }
}

function renderAccounts(list) {
  showPane('choose');
  $('#acctList').innerHTML = (list || []).map(function (a) {
    return '<button class="acct" data-ucc="' + esc(a.ucc) + '">' +
      '<span class="av">' + esc(initials(a.name)) + '</span>' +
      '<span><span class="nm">' + esc(a.name || 'Account') + '</span><br>' +
      '<span class="cd">' + esc(a.ucc) + (a.branch ? ' · ' + esc(a.branch) : '') + '</span></span></button>';
  }).join('');
}

async function chooseAccount(ucc) {
  try {
    var r = await api('/client/auth/select', { method: 'POST', body: { choose: S.choose, ucc: ucc } });
    S.client = r.client;
    enterApp();
  } catch (e) { toast('Could not open that account', e.message, 'bad'); }
}

function tickResend() {
  var btn = $('#resendBtn');
  if (!btn) return;
  var left = Math.ceil((S.resendAt - Date.now()) / 1000);
  if (left > 0) { btn.disabled = true; btn.textContent = 'Resend in ' + left + 's'; }
  else { btn.disabled = false; btn.textContent = 'Resend code'; }
}

/* ---------------- signed in ---------------- */
function enterApp() {
  var c = S.client || {};
  $('#loginStage').classList.add('hide');
  $('#app').classList.remove('hide');
  $('#clientAv').textContent = initials(c.name);
  $('#clientName').textContent = c.name || 'Client';
  $('#clientUcc').textContent = c.ucc || '';
  setStep(3);
  loadIssues();
  loadBids();
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(function () { loadIssues(true); }, 15000);
}

function showCTab(t) {
  S.tab = t;
  $$('#cTabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.ctab === t); });
  ['issues', 'bids', 'allot'].forEach(function (k) {
    $('#cpane-' + k).classList.toggle('hide', k !== t);
  });
  if (t === 'bids') loadBids();
  if (t === 'allot') loadAllotments();
}

function chipFor(st) {
  if (/open/i.test(st)) return 'open';
  if (/upcoming/i.test(st)) return 'soon';
  return 'closed';
}

function issueCard(i) {
  var retOpen = i.ret_status === 'Open';
  var hniOpen = i.hni_status === 'Open';
  var close = retOpen ? new Date(i.ret_close) : hniOpen ? new Date(i.hni_close)
            : new Date(Math.max(new Date(i.ret_close), new Date(i.hni_close)));
  var mine = i.my_bid;

  return '<div class="issue">' +
    '<div class="hd">' +
      '<div style="flex:1">' +
        '<div class="sym">' + esc(i.symbol) + '</div>' +
        '<div class="co">' + esc(i.company) + '</div>' +
        '<div class="isin">' + esc(i.isin) + '</div>' +
      '</div>' +
      '<span class="chip ' + chipFor(i.status_label) + '">' +
        (retOpen || hniOpen ? '<span class="dot live"></span>' : '') + esc(i.status_label) + '</span>' +
    '</div>' +
    '<div class="facts">' +
      '<div><div class="k">Floor price</div><div class="v">' + rupee(i.floor_price) + '</div></div>' +
      '<div><div class="k">Retail min</div><div class="v">' + rupee(i.min_price_retail) + '</div></div>' +
      '<div><div class="k">Tick</div><div class="v">' + inr(i.tick, 2) + '</div></div>' +
      (Number(i.discount_pct) ? '<div><div class="k">Retail discount</div><div class="v">' +
        inr(i.discount_pct, 2) + '%</div></div>' : '') +
      '<div><div class="k">Retail window</div><div class="v" style="font-size:11px">' +
        dt(i.ret_open) + '</div></div>' +
      '<div><div class="k">Closes</div><div class="v" style="font-size:11px">' + dt(i.ret_close) + '</div></div>' +
    '</div>' +
    (mine
      ? '<div class="note good" style="margin-top:11px">Your bid ' + esc(mine.ref) + ' — ' +
        inr(mine.qty, 0) + ' shares at ' + (mine.is_cutoff ? 'cut-off' : rupee(mine.price)) +
        ' · ' + rupee(mine.value, 0) + ' (' + esc(mine.status) + ')</div>'
      : '') +
    '<div class="cdn" data-close="' + close.toISOString() + '">—</div>' +
  '</div>';
}

async function loadIssues(quiet) {
  try {
    var d = await api('/client/api/issues');
    if (d.settings && d.settings.daily_cutoff) $('#cutTime').textContent = d.settings.daily_cutoff;
    var list = d.issues || [];
    $('#clientIssues').innerHTML = list.length
      ? list.map(issueCard).join('')
      : '<div class="tbl-empty">There is no open Offer for Sale right now. ' +
        'Issues appear here as soon as the desk publishes them.</div>';
  } catch (e) {
    if (e.status === 401) return sessionLost();
    if (!quiet) toast('Could not load issues', e.message, 'bad');
  }
}

async function loadBids() {
  try {
    var d = await api('/client/api/me/bids');
    var m = d.margin || {};
    $('#marginSummary').textContent =
      'Available ' + rupee(m.available, 0) + ' · used ' + rupee(m.used, 0) + ' · free ' + rupee(m.free, 0);

    var b = d.bids || [];
    $('#myBidsTbl').innerHTML = b.length ? (
      '<thead><tr><th>Ref</th><th>Scrip</th><th>Category</th>' +
      '<th class="n">Qty</th><th class="n">Price</th><th class="n">Value</th>' +
      '<th>Status</th><th>Placed</th></tr></thead><tbody>' +
      b.map(function (x) {
        return '<tr><td class="m">' + esc(x.ref) + '</td>' +
          '<td><b>' + esc(x.symbol || '') + '</b></td>' +
          '<td><span class="chip ' + (x.category === 'Retail' ? 'retail' : 'hni') + '">' +
            esc(x.category) + '</span></td>' +
          '<td class="n">' + inr(x.qty, 0) + '</td>' +
          '<td class="n">' + (x.is_cutoff ? 'Cut-off' : inr(x.price, 2)) + '</td>' +
          '<td class="n">' + inr(x.value, 0) + '</td>' +
          '<td><span class="chip ' + (x.status === 'Live' ? 'open' : x.status === 'Cancelled' ? 'grey' : 'soon') +
            '">' + esc(x.status) + '</span></td>' +
          '<td class="m">' + dt(x.created_at) + '</td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="tbl-empty">You have not placed a bid yet.</td></tr></tbody>';
  } catch (e) {
    if (e.status === 401) return sessionLost();
    toast('Could not load your bids', e.message, 'bad');
  }
}

async function loadAllotments() {
  try {
    var d = await api('/client/api/me/allotments');
    var a = d.allotments || [];
    $('#myAllotTbl').innerHTML = a.length ? (
      '<thead><tr><th>Scrip</th><th class="n">Allotted</th><th class="n">Price</th>' +
      '<th class="n">Value</th><th>Date</th></tr></thead><tbody>' +
      a.map(function (x) {
        return '<tr><td><b>' + esc(x.symbol || '') + '</b><br>' +
          '<span class="cd" style="font-size:11px;color:var(--muted)">' + esc(x.company || '') + '</span></td>' +
          '<td class="n">' + inr(x.allot_qty, 0) + '</td>' +
          '<td class="n">' + (x.allot_price == null ? '—' : inr(x.allot_price, 2)) + '</td>' +
          '<td class="n">' + inr(x.allot_value, 0) + '</td>' +
          '<td class="m">' + dt(x.allotted_at) + '</td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="tbl-empty">No allotments yet. ' +
        'Results appear here once the exchange file has been processed.</td></tr></tbody>';
  } catch (e) {
    if (e.status === 401) return sessionLost();
    toast('Could not load allotments', e.message, 'bad');
  }
}

function sessionLost() {
  if (S.timer) clearInterval(S.timer);
  $('#app').classList.add('hide');
  $('#loginStage').classList.remove('hide');
  setStep(1); showPane('details');
  toast('Signed out', 'Your session ended. Please sign in again.', 'bad');
}

async function signOut() {
  try { await api('/client/auth/logout', { method: 'POST' }); } catch (e) {}
  location.reload();
}

/* ---------------- countdowns ---------------- */
function tickClocks() {
  var now = new Date();
  $$('.cdn').forEach(function (el) {
    var ms = new Date(el.dataset.close) - now;
    el.textContent = ms > 0 ? 'Closes in ' + hms(ms) : 'Window closed';
  });
  tickResend();
}

/* ---------------- boot ---------------- */
async function boot() {
  // A real <form>, so Enter and a phone's "Send" key submit like anywhere else.
  $('#paneDetails').addEventListener('submit', function (e) { e.preventDefault(); sendCode(); });
  $('#idInput').addEventListener('input', refreshDetails);
  $('#idInput').addEventListener('blur', refreshDetails);
  refreshDetails();
  $('#verifyBtn').addEventListener('click', verifyCode);
  $('#otpBackBtn').addEventListener('click', function () {
    setStep(1); showPane('details');
    refreshDetails();                       // what was typed is preserved, not cleared
    $('#idInput').focus();
  });
  $('#resendBtn').addEventListener('click', sendCode);
  $('#acctList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ucc]');
    if (b) chooseAccount(b.dataset.ucc);
  });
  $('#signOutBtn').addEventListener('click', signOut);
  $$('#cTabs button').forEach(function (b) {
    b.addEventListener('click', function () { showCTab(b.dataset.ctab); });
  });

  setInterval(tickClocks, 1000);

  // Already signed in? Skip the login stage entirely.
  try {
    var me = await api('/client/auth/me');
    S.client = me.client;
    enterApp();
  } catch (e) { /* not signed in — the login stage is already showing */ }
}

document.addEventListener('DOMContentLoaded', boot);
