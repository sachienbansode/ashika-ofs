'use strict';
/* Client journey: mobile + email -> one-time code -> bid.
   CSP-safe: no inline script, no external CDN. */

var $  = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

var S = { ref: null, choose: null, resendAt: 0, timer: null, tab: 'issues', client: null };

/* What an accepted bid is, and is not. The server sends this back with every
 * accepted bid (lib/notices); this is the fallback for an older server, and a test
 * checks the two say the same thing word for word. */
var BID_ACCEPTED_NOTE =
  'This bid is recorded with the OFS desk. It is subject to the margin available ' +
  'at the time the bid is submitted to the exchange, and to acceptance by the ' +
  'exchange.';

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
/**
 * A notification, bottom of the screen, that closes itself.
 *
 * Same shape as the desk's: a Close button for anyone who wants it gone now, and
 * a timer that stops while the card is touched or focused so a reference number
 * cannot vanish part-way through being written down.
 */
function toast(title, msg, kind, ms) {
  var b = document.createElement('div');
  if (kind) b.className = kind;
  b.setAttribute('role', 'status');
  b.innerHTML = '<button class="tx" type="button" aria-label="Close">&times;</button>' +
    '<b>' + esc(title) + '</b><p>' + esc(msg || '') + '</p>';
  $('#toast').appendChild(b);

  var wait = ms == null ? 6000 : Number(ms);
  var timer = null, left = wait, from = 0;
  var go = function () {
    if (timer) clearTimeout(timer);
    left = Math.max(1500, left);
    from = Date.now();
    timer = setTimeout(function () { b.remove(); }, left);
  };
  var hold = function () {
    if (!timer) return;
    clearTimeout(timer); timer = null; left -= Date.now() - from;
  };
  b.addEventListener('mouseenter', hold);
  b.addEventListener('focusin', hold);
  b.addEventListener('touchstart', hold, { passive: true });
  b.addEventListener('mouseleave', go);
  b.addEventListener('focusout', go);
  b.querySelector('.tx').addEventListener('click', function () {
    if (timer) clearTimeout(timer);
    b.remove();
  });
  if (wait > 0) go();
  return b;
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

/* ---------------------------------------------------------- branch / AP sign-in --
 * The address is matched against the branch's own LD record and the code goes THERE.
 * One address can belong to several branch codes — a regional manager's does — so
 * the choice is offered from the list the server resolved when it issued the code,
 * never from anything typed here.
 */
var BR = { ref: null, branches: [] };

function branchHint(msg, bad) {
  var h = $('#brHint');
  h.className = 'hint' + (bad ? ' bad' : '');
  h.textContent = msg;
}

async function sendBranchCode() {
  var email = $('#brEmail').value.trim().toLowerCase();
  var btn = $('#brSendBtn');
  btn.disabled = true;
  branchHint('Sending…');
  try {
    var r = await api('/client/auth/branch/start', { method: 'POST', body: { email: email } });
    BR.ref = r.ref;
    BR.branches = r.branches || [];
    S.ref = null;                       // this is the branch door, not the client one
    S.identifier = email;
    showIdentifier(email, 'email');

    $('#otpSentTo').textContent = r.sent_to ? ('Sent to ' + r.sent_to) : 'Check your branch mailbox';
    $('#otpHint').className = 'hint';
    $('#otpHint').textContent = r.branches && r.branches.length > 1
      ? 'This address is registered against ' + r.branches.length + ' branch codes — you will pick one next.'
      : (r.message || '');
    $('#demoOtp').innerHTML = r.test_mode
      ? '<div class="demo-otp"><span>Test mode — nothing was sent. Code:</span><b>' +
        esc(r.test_code) + '</b></div>' : '';
    $('#testBanner').classList.toggle('hide', !r.test_mode);

    S.resendAt = Date.now() + (r.resend_after_s || 60) * 1000;
    buildOtpBoxes();
    setStep(2); showPane('otp');
    var first = $('#otpBox input'); if (first) first.focus();
    branchHint('The address registered against your branch code in Ashika\'s records.');
  } catch (e) {
    // Branch addresses are business addresses already on contract notes, so naming
    // the failure costs nothing and saves a support call. "Disabled by the desk" and
    // "not registered" send someone to completely different places.
    branchHint((e.body && e.body.message) || e.message || 'Could not send a code just now.', true);
    $('#brEmail').focus();
  } finally { btn.disabled = false; }
}

/** Verify a branch code. Called by the shared OTP box when BR.ref is set. */
async function verifyBranchCode(code, chosen) {
  var r = await api('/client/auth/branch/verify', { method: 'POST',
    body: { ref: BR.ref, otp: code, branch_code: chosen || null } });

  if (r.choose_branch) {
    // More than one branch on this address: ask, now that the code is verified.
    $('#brPick').classList.remove('hide');
    $('#brPick').innerHTML = '<div class="fl">Which branch are you signing in as?</div>' +
      BR.branches.filter(function (b) { return (r.branch_codes || []).indexOf(b.code) >= 0; })
        .map(function (b) {
          return '<button type="button" class="acct" data-br="' + esc(b.code) + '">' +
            '<div><b>' + esc(b.code) + '</b> — ' + esc(b.name || '') + '</div>' +
            '<div class="cd">' + esc(b.type_label || '') + '</div></button>';
        }).join('');
    showPane('branch');
    $('#brPick').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-br]');
      if (b) verifyBranchCode(code, b.dataset.br).catch(function (e) {
        branchHint((e.body && e.body.message) || e.message || 'Sign-in failed.', true);
      });
    });
    return;
  }

  /* A branch or AP gets the DESK's screens, not this one.
   *
   * They are acting for a book of clients: a dashboard, a bid book with filters and
   * a CSV, and the full bid form. The investor shell is built for one person's own
   * bid and cannot show any of that, so the session goes straight to /partner/ —
   * which is the back-office page, scoped on the server to this branch's clients.
   *
   * The cookie is already set by the verify call above, so this is a navigation and
   * not a second sign-in. */
  location.href = '/partner/';
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
  // 'Branch' is the second door on step 1; it is hidden alongside Details whenever
  // the flow moves on, so a half-finished branch form cannot sit under the code box.
  ['Details', 'Branch', 'Otp', 'Choose'].forEach(function (p) {
    var el = $('#pane' + p);
    if (el) el.classList.toggle('hide', p.toLowerCase() !== which);
  });
}

/** Show or hide one element. */
function show(el, on) { if (el) el.classList.toggle('hide', !on); }

/* ---------------- step 1: details ---------------- */
var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * One field takes a client code, a 10-digit mobile, or an email. Ten digits is
 * reported as a mobile, and the server also tries it as a UCC — some client codes
 * are numeric.
 */
var UCC_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/]{1,19}$/;
function identifierKind() {
  var v = $('#idInput').value.trim();
  if (!v) return null;
  if (v.indexOf('@') >= 0) return EMAIL_RE.test(v) ? 'email' : null;
  var phoneish = v.replace(/[\s()+\-]/g, '');
  if (/^\d+$/.test(phoneish) && phoneish.replace(/\D/g, '').slice(-10).length === 10) return 'mobile';
  return UCC_RE.test(v) ? 'ucc' : null;
}

/* The exact identifier the server turned down, lower-cased, or null.
 *
 * Two different kinds of wrong live in this field and they do not clear at the
 * same moment. SHAPE - "that is not a client code, a mobile or an email" - is a
 * fact about what is in the box, and is recomputed on every keystroke. REFUSED -
 * "well formed, and no account has it" - is a fact about a VALUE, and it stands
 * until that value changes.
 *
 * Conflating them broke both directions. A well-formed address that belongs to
 * nobody is still well formed, so refreshDetails set aria-invalid back to false
 * the instant the refusal arrived and a screen reader was told the field was
 * fine. And the red sentence was pinned the other way: the hint was only
 * rewritten when it was NOT already marked bad, so once an error had been shown
 * it stayed, word for word, while the investor corrected the address in front of
 * it - a wrong answer to a question they had already fixed.
 */
var REFUSED = null;                 // { id, message }

/**
 * Validity is shown as it is typed rather than on submit: a tick when a field is
 * well-formed, and Send stays disabled until both are. Nobody should press a button
 * only to be told their mobile is nine digits.
 */
function refreshDetails() {
  var el = $('#idInput');
  var kind = identifierKind();
  var typed = el.value.trim().length > 0;
  var refused = REFUSED !== null && el.value.trim().toLowerCase() === REFUSED.id;

  // No green tick on a value the server has already turned down, however
  // well-formed it is.
  el.closest('.field').classList.toggle('valid', !!kind && !refused);
  // Only complain about the SHAPE once the field has been left, never
  // mid-typing. A refusal complains immediately, because it is already an answer.
  el.setAttribute('aria-invalid',
    String(refused || (!kind && typed && document.activeElement !== el)));

  // Say which one was recognised, so a typo in an email is obvious immediately.
  var hint = $('#detailsHint');
  if (refused) {
    /* Put the server's sentence back. Typing the refused value in again marked
     * the field and took the tick away but left the neutral "Recognised as an
     * email address" underneath it - so a screen reader was told the field was
     * invalid while the screen said nothing was wrong. */
    hint.className = 'hint bad';
    hint.textContent = REFUSED.message;
  } else {
    hint.className = 'hint';
    hint.textContent = kind === 'mobile' ? 'Recognised as a mobile number.'
      : kind === 'email' ? 'Recognised as an email address.'
      : kind === 'ucc' ? 'Recognised as a client code.'
      : 'Use whichever you have — it must match your Ashika account.';
  }
  // Still pressable on a refused value: an account activated this morning is a
  // reason to try the same address again.
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
    hint.textContent = 'Enter your client code, your registered mobile number, or your registered email address.';
    $('#idInput').setAttribute('aria-invalid', 'true'); $('#idInput').focus(); return;
  }
  hint.className = 'hint';

  REFUSED = null;                     // this value is being asked about again
  busy('#sendBtn', true, 'Sending…');
  try {
    var r = await api('/client/auth/start', { method: 'POST', body: { identifier: identifier } });
    S.ref = r.ref || null;
    BR.ref = null;                      // the client door, not the branch one

    // Keep what they typed on screen for the rest of the sign-in. Without it the
    // OTP step is anonymous: nothing tells them WHICH code or number the code went
    // to, so a typo is only discovered when the SMS never arrives.
    S.identifier = r.identifier || identifier;
    showIdentifier(S.identifier, r.kind);

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
    // A miss must NOT advance to the code step — there is no code coming. Stay put,
    // mark the field, and say so.
    /* Only a refusal of the VALUE is remembered. "Too many requests" and "we could
     * not send it just now" are about the moment, not about what was typed, so
     * they clear on the next keystroke like any other transient message. */
    var said = (e.body && e.body.message) || e.message || 'Could not send a code just now.';
    if (e.body && e.body.error === 'no_client') {
      REFUSED = { id: identifier.toLowerCase(), message: said };
    }
    hint.className = 'hint bad';
    hint.textContent = said;
    $('#idInput').setAttribute('aria-invalid', 'true');
    $('#idInput').focus();
    $('#idInput').select();
    if (e.body && e.body.retry_after_s) S.resendAt = Date.now() + e.body.retry_after_s * 1000;
  } finally {
    busy('#sendBtn', false, 'Send code');
    refreshDetails();
  }
}

function backToDetails() {
  setStep(1); showPane('details');
  showIdentifier(null);
  // The help panel belongs to a code box that is waiting. Going back means there
  // is nothing left to wait for.
  showNoCodeHelp(false);
  refreshDetails();                         // what was typed is preserved, not cleared
  $('#idInput').focus();
  $('#idInput').select();
}

/** Show the client code / mobile / email being signed in with, until it completes. */
function showIdentifier(value, kind) {
  var el = $('#idUsed');
  if (!el) return;
  if (!value) { el.classList.add('hide'); el.textContent = ''; return; }
  var label = kind === 'ucc' ? 'Client code' : kind === 'mobile' ? 'Mobile' : kind === 'email' ? 'Email' : 'Signing in as';
  el.innerHTML = '<span class="k">' + esc(label) + '</span><b>' + esc(value) + '</b>' +
    '<button type="button" class="chg" id="idChange">Change</button>';
  el.classList.remove('hide');
  var b = $('#idChange');
  if (b) b.addEventListener('click', backToDetails);
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
    // One code box, two doors. BR.ref is set only by the branch door, and the two
    // are never both live: sendBranchCode clears S.ref and vice versa.
    if (BR.ref) {
      await verifyBranchCode(code, null);
      return;
    }
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
  showNoCodeHelp(left <= 0);
}

/**
 * What to do when no code arrives.
 *
 * This page answers identically whether or not the identifier belongs to a
 * client. That is deliberate and it is the right default: an unauthenticated
 * caller must not be able to use a sign-in box to find out which of Ashika's
 * accounts exist, and the per-identifier throttle cannot help, because a miss
 * writes no challenge row and so never moves the counter for exactly the
 * requests being used to enumerate. The desk can trade that away in Settings
 * (Unknown sign-in identifier - generic or reveal); generic is the default.
 *
 * The cost of generic lands here. Somebody who mistyped their email, or who put
 * a work address into the client door, waits at a code box that will never be
 * filled and is told nothing at all - not even what to check.
 *
 * The fix is not to say whether the account exists. It is to say what is
 * actually wrong when no code arrives, which is the same short list every time
 * and gives nothing away: it is shown to EVERYONE once the cooldown expires,
 * including the clients whose code is genuinely on its way.
 */
function showNoCodeHelp(on) {
  var el = $('#otpNoCode');
  if (!el) return;
  /* Not on the branch door. That one names its own failures at step 1 - "not
   * registered", "disabled by the desk" - because a branch address is a business
   * address already printed on contract notes, so it never strands anybody here. */
  if (!on || BR.ref) { el.classList.add('hide'); return; }
  /* And only while there is a code box to be stranded at. The clock ticks every
   * second and calls this, so without the pane test the panel came straight back
   * after Use different details and sat over a form that is not waiting. */
  var pane = $('#paneOtp');
  if (!pane || pane.classList.contains('hide')) { el.classList.add('hide'); return; }
  if (!el.innerHTML) {
    el.innerHTML =
      '<b>No code yet?</b>' +
      '<ul>' +
        '<li>It is sent to the mobile and email <b>registered on your trading account</b> — ' +
          'not to a work address.</li>' +
        '<li>The account has to be active. A dormant or closed account cannot bid.</li>' +
        '<li>Branch, Authorised Partner and back-office users do not sign in here — ' +
          'use <b>Branch / AP</b> above.</li>' +
      '</ul>' +
      '<div>Still nothing? Call your relationship manager.</div>';
  }
  el.classList.remove('hide');
}

/* ---------------- signed in ---------------- */
/**
 * This shell is the CLIENT's, and only the client's.
 *
 * It used to serve a branch too, switching a tab on, adding a UCC field to the bid
 * box and flipping the bid endpoint — a client portal wearing extra clothes. A
 * branch needs a dashboard, a filterable bid book and MIS over a book of clients,
 * none of which fits a screen built around one person's single bid, and every one
 * would have been another fork. They get the desk's own screens at /partner now,
 * so every one of those forks is gone from here.
 *
 * The branch DOOR stays on the sign-in page: that is where a branch signs in, and
 * verifyBranchCode sends them to /partner once it has.
 */
function enterApp() {
  var c = S.client || {};
  $('#loginStage').classList.add('hide');
  $('#app').classList.remove('hide');
  $('#clientAv').textContent = initials(c.name);
  $('#clientName').textContent = c.name || 'Client';
  $('#clientUcc').textContent = c.ucc || '';
  setStep(3);
  // A refresh lands back where they were, not on Open issues.
  restoreCTabFromHash();
  loadIssues();
  loadBids(0);
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(function () { loadIssues(true); }, 15000);
}

/**
 * Which tab you are on survives a refresh — it lives in the URL hash.
 *
 * On a phone this is the difference between checking your bid and losing your
 * place: the browser reloads a backgrounded tab on its own, and coming back to
 * Open issues every time is its own small annoyance.
 */
function showCTab(t, fromHash) {
  S.tab = t;
  if (!fromHash) {
    try {
      if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
    } catch (e) { /* nothing to do; the tab still switches */ }
  }

  $$('#cTabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.ctab === t); });
  ['issues', 'place', 'bids', 'allot', 'rules'].forEach(function (k) {
    var el = $('#cpane-' + k);
    if (el) el.classList.toggle('hide', k !== t);
  });
  // Reached straight from the tab bar or from a refreshed URL, with no offer
  // chosen: draw whatever is chosen, or the line saying how to choose one.
  if (t === 'place') renderPlace();
  if (t === 'bids') loadBids(0);
  if (t === 'allot') loadAllotments();
  if (t === 'rules') renderRules($('#rulesBox'));
}

/** The sign-in page's "read the bidding rules" toggle. Bound ONCE: it used to be
 *  re-bound inside showCTab, so after four tab switches one click fired the toggle
 *  four times and it looked like the link had stopped working. */
function bindRulesLink() {
  var rl = $('#rulesLink');
  if (!rl || rl.dataset.bound) return;
  rl.dataset.bound = '1';
  rl.addEventListener('click', function (e) {
    e.preventDefault();
    var box = $('#loginRules');
    var open = !box.classList.contains('hide');
    if (open) { box.classList.add('hide'); rl.textContent = 'Read the bidding rules'; return; }
    renderRules(box);
    box.classList.remove('hide');
    rl.textContent = 'Hide the bidding rules';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

/** The tab named in the address bar, if it is one this page has. */
function restoreCTabFromHash() {
  var t = String(location.hash || '').replace(/^#/, '').trim();
  if (!t) return false;
  var known = $$('#cTabs button').some(function (b) { return b.dataset.ctab === t; });
  if (!known) return false;
  showCTab(t, true);
  return true;
}

function chipFor(st) {
  if (/open/i.test(st)) return 'open';
  if (/upcoming/i.test(st)) return 'soon';
  return 'closed';
}

/* ------------------------------------------------------------- the offers --
 *
 * One row per offer, and one thing to do with it.
 *
 * This was a stack of large cards with a whole bid form inside each, so an
 * investor scrolled past three forms to read the fourth offer, and the form for
 * the offer they wanted was never the one on screen. The list says what is on;
 * Place bid takes them to the form, which lives on its own page now.
 */
function issueRow(i) {
  var retOpen = i.ret_status === 'Open';
  var hniOpen = i.hni_status === 'Open';
  var open = retOpen || hniOpen;
  var mine = i.my_bid;
  var close = retOpen ? closeOf(i, 'Retail') : hniOpen ? closeOf(i, 'HNI')
            : (new Date(closeOf(i, 'Retail')) > new Date(closeOf(i, 'HNI'))
                 ? closeOf(i, 'Retail') : closeOf(i, 'HNI'));

  return '<tr>' +
    '<td class="rowhead"><b>' + esc(i.symbol) + '</b>' +
      '<div class="sub">' + esc(i.company || '') + '</div>' +
      '<div class="sub m">' + esc(i.isin || '') + '</div></td>' +
    '<td data-label="Status"><span class="chip ' + chipFor(i.status_label) + '">' +
      (open ? '<span class="dot live"></span>' : '') + esc(i.status_label) + '</span></td>' +
    '<td class="n" data-label="Floor">' + rupee(i.floor_price) + '</td>' +
    '<td class="n" data-label="Retail min">' + rupee(i.min_price_retail) + '</td>' +
    '<td class="m" data-label="Closes">' + dt(close) +
      '<div class="cdn sub" data-close="' + esc(new Date(close).toISOString()) + '">—</div></td>' +
    '<td data-label="Your bid">' + (mine
      ? '<span class="chip ' + (mine.status === 'Live' ? 'open' : 'grey') + '">' + esc(mine.status) +
        '</span><div class="sub">' + inr(mine.qty, 0) + ' at ' +
        (mine.is_cutoff ? 'cut-off' : rupee(mine.price)) + '</div>'
      : '<span class="sub">—</span>') + '</td>' +
    '<td class="act">' + (!open ? '<span class="sub">Closed</span>'
      : !OFS_BIDMATH.issueTradable(i, SETTINGS)
        ? '<span class="sub">' + esc(OFS_BIDMATH.notTradableMessage(i, SETTINGS)) + '</span>'
      : '<button class="btn btn-p btn-sm" data-place="' + esc(i.id) + '">' +
        (mine ? 'Change bid' : 'Place bid') + '</button>') + '</td>' +
  '</tr>';
}

/**
 * The bid form, on its own page.
 *
 * Deliberately a .bidbox with the same data-bf fields every other bid form in
 * this app has, so fillSuggested, readBidBox, checkBid, submitBid and
 * withdrawBid all work on it unchanged. A second implementation of a bid form is
 * a second set of rules to keep in step with the server, and it never stays in
 * step.
 */
function placePage(i, mine) {
  if (!OFS_BIDMATH.issueTradable(i, SETTINGS)) {
    return '<div class="note bad">' + esc(OFS_BIDMATH.notTradableMessage(i, SETTINGS)) + '</div>';
  }
  var retOpen = i.ret_status === 'Open';
  var hniOpen = i.hni_status === 'Open';
  var cats = [];
  if (retOpen) cats.push(['Retail', 'Retail']);
  if (hniOpen) cats.push(['HNI', 'HNI / Non-Retail']);
  var cat = mine && cats.some(function (c) { return c[0] === mine.category; })
    ? mine.category : (cats[0] || ['Retail'])[0];

  var fact = function (k, v) {
    return '<div><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  };

  return '<div class="bidbox" data-bid-issue="' + esc(i.id) + '">' +
    '<div class="cp-facts">' +
      fact('Floor price', rupee(i.floor_price)) +
      fact('Retail min', rupee(i.min_price_retail)) +
      fact('Tick', inr(i.tick, 2)) +
      fact('Lot', inr(i.lot || 1, 0)) +
      (Number(i.discount_pct) ? fact('Retail discount', inr(i.discount_pct, 2) + '%') : '') +
      fact('Closes', '<span style="font-size:11px">' +
        dt(closeOf(i, retOpen ? 'Retail' : 'HNI')) + '</span>') +
    '</div>' +
    '<div class="cp-row">' +
      '<label class="cp-f"><span class="k">Issue</span>' +
        '<input type="text" value="' + esc(i.symbol) + '" readonly></label>' +
      '<label class="cp-f"><span class="k">Client code</span>' +
        '<input type="text" value="' + esc((S.client && S.client.ucc) || '') + '" readonly></label>' +
      '<label class="cp-f"><span class="k">Category</span><select data-bf="cat">' +
        cats.map(function (c) {
          return '<option value="' + c[0] + '"' + (c[0] === cat ? ' selected' : '') + '>' +
            esc(c[1]) + '</option>';
        }).join('') + '</select></label>' +
      '<label class="cp-f"><span class="k">Bid type</span><select data-bf="type">' +
        '<option value="cutoff"' + (mine && mine.is_cutoff ? ' selected' : '') + '>Cut-off price</option>' +
        '<option value="limit"' + (mine && !mine.is_cutoff ? ' selected' : '') + '>My own price</option>' +
      '</select></label>' +
      '<label class="cp-f"><span class="k">Quantity</span>' +
        '<input type="number" min="1" step="1" data-bf="qty"' +
        (mine ? ' value="' + esc(String(mine.qty)) + '"' : '') + '></label>' +
      (function () {
        /* A cut-off bid is not a bid without a price. It takes the price this
         * offer sets — the floor, or the retail cut-off minimum where one is
         * published — and it is held and margined at exactly that. The box used
         * to be emptied and greyed out, so an investor choosing "Cut-off price"
         * saw no price anywhere on the form and no total against their quantity.
         * Now it shows the figure, readonly. */
        var isCut = !mine || mine.is_cutoff;
        var cp = cutoffPriceFor(i, cat);
        return '<label class="cp-f"><span class="k">Price</span>' +
          '<input type="number" min="0" step="' + (Number(i.tick) || 0.05) + '" data-bf="price"' +
          (isCut ? (cp == null ? '' : ' value="' + esc(String(cp)) + '" data-cutfill="1"') +
                   ' readonly placeholder="Set by the offer"'
                 : ' value="' + esc(String(Number(mine.price))) + '"' +
                   ' placeholder="At or above floor"') +
          '></label>';
      }()) +
      exchangeField(i, mine).replace('bb-f', 'cp-f') +
    '</div>' +
    '<div class="cp-total"><span class="k">Total value</span>' +
      '<b data-bf="value">—</b><span class="sub">Quantity × price.</span></div>' +
    '<div class="bb-verdict" data-bf="verdict"></div>' +
    '<div class="bar" style="padding:0">' +
      '<button class="btn btn-o btn-sm" data-bf="fill">Fill suggested bid</button>' +
      '<button class="btn btn-o btn-sm" data-bf="check">Check</button>' +
      '<button class="btn btn-p btn-sm" data-bf="submit">' +
        (mine ? 'Update bid' : 'Place bid') + '</button>' +
      (mine ? '<button class="btn btn-o btn-sm" data-bf="cancel">Withdraw</button>' : '') +
      '<div class="sp"></div>' +
      '<button class="btn btn-o btn-sm" data-bf="back">Back to issues</button>' +
    '</div>' +
  '</div>';
}

/** Open the Place bid page on one offer, with it already selected. */
function openPlace(issueId) {
  PLACE_ON = String(issueId || '');
  showCTab('place');
  renderPlace();
}

function renderPlace() {
  var box = $('#cpForm');
  if (!box) return;
  var i = ISSUES_BY_ID[PLACE_ON];
  var none = $('#cpNone');
  if (!i) {
    box.innerHTML = '';
    if (none) none.classList.remove('hide');
    if ($('#cpFor')) $('#cpFor').textContent = '';
    return;
  }
  if (none) none.classList.add('hide');
  var mine = BIDS_BY_ISSUE[PLACE_ON];
  if ($('#cpTitle')) $('#cpTitle').textContent = mine ? 'Change your bid' : 'Place a bid';
  if ($('#cpFor')) {
    $('#cpFor').textContent = i.symbol + ' · ' + (i.company || '') +
      ((S.client && S.client.ucc) ? ' · ' + S.client.ucc : '');
  }
  /* Same rule as the issues list: a background refresh must not empty a form the
   * investor is part way through typing into. */
  var keep = captureBidForms();
  box.innerHTML = placePage(i, mine || null);
  restoreBidForms(keep);
  applyPriceMode(box.querySelector('.bidbox'));
  recalcTotal();
}

/**
 * What a cut-off bid is priced at, for a category.
 *
 * Retail takes the published cut-off minimum where the offer has one and the floor
 * otherwise; non-retail always takes the floor. The server computes the same two
 * figures and sends them with the offer, so the screen never has to guess — which
 * matters, because the total this draws and the margin the server holds have to be
 * the same number.
 *
 * recalcTotal used to read min_price_retail whatever the category, so an HNI
 * cut-off bid was totalled at the retail price.
 */
function cutoffPriceFor(i, cat) {
  if (!i) return null;
  var p = Number(cat === 'HNI' ? i.min_price_hni : i.min_price_retail);
  if (isFinite(p) && p > 0) return p;
  var f = Number(i.floor_price);
  return isFinite(f) && f > 0 ? f : null;
}

/**
 * Put the price box into the mode the bid type asks for.
 *
 * Cut-off: the offer's own price, readonly. Own price: empty and typeable, unless
 * the investor already typed something that is theirs to keep. One function, called
 * from both the Place bid page and the issues list, because two copies of this rule
 * is how the two screens disagreed about whether a cut-off bid has a price.
 */
function applyPriceMode(box) {
  if (!box) return;
  var g = function (k) { return box.querySelector('[data-bf="' + k + '"]'); };
  var price = g('price');
  if (!price) return;
  var i = ISSUES_BY_ID[box.getAttribute('data-bid-issue')];
  var cutoff = g('type') && g('type').value === 'cutoff';
  if (cutoff) {
    var cp = cutoffPriceFor(i, (g('cat') && g('cat').value) || 'Retail');
    price.value = cp == null ? '' : String(cp);
    price.readOnly = true;
    price.disabled = false;
    price.setAttribute('data-cutfill', '1');
  } else {
    if (price.getAttribute('data-cutfill') === '1') {
      price.value = '';
      price.removeAttribute('data-cutfill');
    }
    price.readOnly = false;
    price.disabled = false;
  }
}

/** The derived total, so the figure is there before Check is pressed. */
function recalcTotal() {
  var box = document.querySelector('#cpForm .bidbox');
  if (!box) return;
  var out = box.querySelector('[data-bf="value"]');
  if (!out) return;
  var g = function (k) { return box.querySelector('[data-bf="' + k + '"]'); };
  var i = ISSUES_BY_ID[box.getAttribute('data-bid-issue')];
  var qty = Number(g('qty') && g('qty').value) || 0;
  var cutoff = g('type') && g('type').value === 'cutoff';
  var cat = (g('cat') && g('cat').value) || 'Retail';
  var price = cutoff ? Number(cutoffPriceFor(i, cat)) || 0
                     : Number(g('price') && g('price').value) || 0;
  out.textContent = qty && price ? rupee(qty * price, 0) : '—';
}

var PLACE_ON = '';

/**
 * Which exchange this bid goes to.
 *
 * An offer runs on NSE, on BSE, or on both, and one bid reaches exactly ONE of
 * them. Where the offer is on one exchange there is nothing to choose and the
 * field just says so. Where it is on both, somebody has to choose — and until
 * now nobody could: this box had no exchange at all, so every bid on a
 * both-exchange offer was refused on submit with a message about a choice the
 * screen never offered. It defaults to the same exchange the desk's form
 * defaults to, and can be changed here.
 */
function exchangeField(i, mine) {
  // Where the offer is listed, narrowed by where the desk is live. One usable
  // exchange is not a choice, so it is shown rather than asked.
  var usable = OFS_BIDMATH.exchangesFor(i, SETTINGS);
  var pick = (mine && mine.exchange && usable.indexOf(mine.exchange) >= 0)
    ? mine.exchange : OFS_BIDMATH.defaultExchange(i, SETTINGS);
  if (usable.length < 2) {
    return '<label class="bb-f"><span>Exchange</span>' +
      '<input type="text" value="' + esc(usable[0] || '—') + '" data-bf="exch" readonly></label>';
  }
  return '<label class="bb-f"><span>Exchange</span><select data-bf="exch">' +
    usable.map(function (x) {
      return '<option value="' + x + '"' + (x === pick ? ' selected' : '') + '>' + x + '</option>';
    }).join('') + '</select></label>';
}

/**
 * Fill the form with a bid that would pass — the desk's "Fill suggested bid",
 * on the client's own screen and computed by the same shared code, so the two
 * never quote different numbers for the same offer.
 *
 * It is a starting point, not advice: everything in it can be changed, and the
 * server checks it again either way.
 */
function fillSuggested(box) {
  var i = ISSUES_BY_ID[box.getAttribute('data-bid-issue')];
  if (!i) return;
  var g = function (k) { return box.querySelector('[data-bf="' + k + '"]'); };
  var sug = OFS_BIDMATH.suggestedBid(i, g('cat').value, SETTINGS);
  if (!sug) {
    return showVerdict(box, 'bad', ['This offer has no published floor price to work from yet.']);
  }
  g('type').value = 'limit';
  // A suggested bid is a price bid, so the box becomes the investor's again.
  g('price').disabled = false;
  g('price').readOnly = false;
  g('price').removeAttribute('data-cutfill');
  g('price').value = sug.price;
  g('qty').value = sug.qty;
  var ex = g('exch');
  if (ex && ex.tagName === 'SELECT' && !ex.value) ex.value = OFS_BIDMATH.defaultExchange(i, SETTINGS);
  showVerdict(box, '', [sug.why, 'Check it before you place it — you can change any of it.']);
}

/** Read one card's form. `mine` decides place vs modify. */
function readBidBox(box) {
  var g = function (k) { return box.querySelector('[data-bf="' + k + '"]'); };
  var cutoff = g('type').value === 'cutoff';
  var body = {
    issue_id: box.getAttribute('data-bid-issue'),
    category: g('cat').value,
    qty: Number(g('qty').value) || 0,
    is_cutoff: cutoff,
    price: cutoff ? null : Number(g('price').value) || 0,
    // Only ever NSE or BSE. A single-exchange offer shows its exchange in a
    // read-only box, and an offer with none yet shows a dash — neither is a
    // choice, and neither belongs in the request.
    exchange: /^(NSE|BSE)$/.test((g('exch') && g('exch').value) || '') ? g('exch').value : null
  };
  // The UCC is never in the body: the session decides whose bid this is, and that
  // is the whole reason a client cannot bid on another account by editing a request.
  return body;
}

/** One session, one endpoint. */
function bidBase() { return '/client/api/bids'; }

function showVerdict(box, kind, lines) {
  var v = box.querySelector('[data-bf="verdict"]');
  v.className = 'bb-verdict ' + (kind || '');
  v.innerHTML = (lines || []).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
}

async function checkBid(box, quiet) {
  var body = readBidBox(box);
  var editing = BIDS_BY_ISSUE[body.issue_id];
  if (editing) body.editingId = editing.id;
  try {
    var r = await api(bidBase() + '/validate', { method: 'POST', body: body });
    if (r.ok) {
      showVerdict(box, 'ok', [
        'Order value ' + rupee(r.value, 0) + '.',
        'Free margin ' + rupee(r.free_margin, 0) + '.'
      ]);
    } else {
      showVerdict(box, 'bad', r.errors);
    }
    return r.ok;
  } catch (e) {
    if (e.status === 401) { sessionLost(); return false; }
    if (!quiet) showVerdict(box, 'bad', [e.message]);
    return false;
  }
}

async function submitBid(box, otp) {
  var body = readBidBox(box);
  // Keyed by issue, which is sound here: a client has at most one bid per issue.
  var editing = BIDS_BY_ISSUE[body.issue_id];
  var btn = box.querySelector('[data-bf="submit"]');
  if (otp) { body.otp_ref = otp.ref; body.otp = otp.code; }
  btn.disabled = true;
  try {
    var r = editing
      ? await api(bidBase() + '/' + editing.id, { method: 'PUT', body: body })
      : await api(bidBase(), { method: 'POST', body: body });
    toast(editing ? 'Bid updated' : 'Bid placed',
      (r.bid && r.bid.ref ? r.bid.ref + ' — ' : '') + 'your bid is with the OFS desk.', 'ok', 20000);
    await loadIssues();
    /* loadIssues rebuilds every card, so the confirmation is written AFTER it —
     * into the fresh box, not the one that was just replaced. It stays on the
     * screen rather than fading with the toast, because the condition on it is
     * the part the client has to keep: the bid is with the desk, and the exchange
     * blocks margin when the file reaches it, not when this form was filled. */
    var fresh = document.querySelector('.bidbox[data-bid-issue="' + body.issue_id + '"]');
    if (fresh) {
      showVerdict(fresh, 'ok', [
        (editing ? 'Bid updated' : 'Bid placed') + (r.bid && r.bid.ref ? ' — ' + r.bid.ref : '') + '.',
        (r && r.notice) || BID_ACCEPTED_NOTE
      ]);
    }
  } catch (e) {
    if (e.status === 401) return sessionLost();
    if (e.status === 428 && e.body && e.body.error === 'otp_required') {
      /* A client bidding for THEMSELVES is never asked for a code — the session is
       * the confirmation. This branch used to open the "the client must confirm
       * this" box, which belonged to a branch acting on someone else's behalf and
       * moved to the partner shell with the rest of it. Reaching it here would mean
       * the server thinks this session is acting for another account, so say that
       * plainly rather than showing a code box that cannot be right. */
      return showVerdict(box, 'bad', [(e.body && e.body.message) ||
        'This bid needs a confirmation your session cannot give. Please contact the OFS desk.']);
    }
    var errs = (e.body && e.body.errors) || [(e.body && e.body.message) || e.message];
    showVerdict(box, 'bad', errs);
    toast(editing ? 'Bid not updated' : 'Bid not placed', errs[0], 'bad');
  } finally { btn.disabled = false; }
}

async function withdrawBid(box) {
  var issueId = box.getAttribute('data-bid-issue');
  var editing = BIDS_BY_ISSUE[issueId];
  if (!editing) return;
  if (!window.confirm('Withdraw bid ' + editing.ref + '? This cannot be undone.')) return;
  try {
    await api(bidBase() + '/' + editing.id, { method: 'DELETE' });
    toast('Bid withdrawn', editing.ref + ' has been cancelled.', 'ok');
    await loadIssues();
  } catch (e) {
    if (e.status === 401) return sessionLost();
    showVerdict(box, 'bad', [e.message]);
  }
}

/**
 * Is the offer this bid belongs to still open to it?
 *
 * The open-issues list is the better answer, because the server worked the status
 * out. But My bids and Open issues load side by side and either can land first,
 * so with the list not yet in hand the bid's own close time answers instead -
 * showing a dash on every row for the first second, and then buttons, is its own
 * small lie about what the portal can do.
 */
function bidStillOpen(x) {
  var i = ISSUES_BY_ID[String(x.issue_id)];
  if (i) return (x.category === 'Retail' ? i.ret_status : i.hni_status) === 'Open';
  var close = x.category === 'Retail' ? x.ret_close : x.hni_close;
  if (!close) return false;
  var t = new Date(close).getTime();
  return !isNaN(t) && t > Date.now();
}

/**
 * Modify from the My bids tab: go to the offer's own card.
 *
 * Not a second bid form. The card carries the floor, the tick, the cap and the
 * suggested-bid button, and it is already filled with this bid because the
 * server sends it as my_bid - so the honest thing is to take the investor there
 * rather than build a thinner copy that can disagree with it.
 */
function modifyFromList(issueId) {
  var go = function () {
    if (!ISSUES_BY_ID[String(issueId)]) {
      return toast('That offer is closed', 'This bid can no longer be changed.', 'bad');
    }
    openPlace(issueId);
    var qty = document.querySelector('#cpForm [data-bf="qty"]');
    if (qty && qty.focus) qty.focus();
  };
  if (ISSUES_BY_ID[String(issueId)]) go();
  else loadIssues().then(go);
}

/** Withdraw from the My bids tab, on the same endpoint the card uses. */
async function withdrawFromList(id, ref) {
  if (!window.confirm('Withdraw bid ' + ref + '? This cannot be undone.')) return;
  try {
    await api(bidBase() + '/' + id, { method: 'DELETE' });
    toast('Bid withdrawn', ref + ' has been cancelled.', 'ok');
    await loadIssues();
    await loadBids(BIDS_PAGE.offset);
  } catch (e) {
    if (e.status === 401) return sessionLost();
    toast('Could not withdraw', e.message, 'bad');
  }
}

var BIDS_BY_ISSUE = {};
/* The issues themselves, and the caps that go with them — "Fill suggested bid"
 * needs the floor, the tick and the lot, and the box only carries an id. */
var ISSUES_BY_ID = {};
var SETTINGS = {};

/**
 * What is half-typed in a bid form, so a background refresh cannot take it.
 *
 * The issue list reloads every fifteen seconds and the bid form lives INSIDE the
 * issue card, so every refresh rebuilt the form from the server's copy - and an
 * investor who took more than fifteen seconds to type a quantity watched it
 * empty itself. That is what the desk was shown on video: quantity 100 and a
 * chosen bid type, gone twenty seconds later, with nobody having touched it.
 *
 * So the values are lifted out before the rebuild and put back after, along with
 * the caret. Only forms the investor has actually touched are restored: an
 * untouched card takes the server's fresh copy, which is the whole point of
 * refreshing it.
 */
/* Which bid forms the investor has actually typed in. Keyed by issue id, set by
 * the delegated input handler, cleared when that form is submitted or withdrawn. */
var DIRTY = {};

/**
 * The time in the header, in sync with what actually closes bidding.
 *
 * It read the desk-wide cut-off setting and said "Cut-off 15:15" over an offer
 * whose own window ran to 17:15 - the investor was told bidding ends two hours
 * before it does, and the back office was saying something different again.
 * Bidding runs to each offer's own close, so the header shows the next one of
 * those; with nothing open it falls back to the desk setting, which is then the
 * only answer there is.
 */
function showCutoff(list, settings) {
  var el = $('#cutTime');
  if (!el) return;
  var label = el.parentNode && el.parentNode.querySelector('[data-cut-label]');
  var now = Date.now();
  var closes = (list || [])
    .filter(function (i) { return i.ret_status === 'Open' || i.hni_status === 'Open'; })
    .map(function (i) {
      // The enforced close, not the typed one, or the strip counts down to a time
      // the cut-off will not honour.
      var t = [closeOf(i, 'Retail'), closeOf(i, 'HNI')]
        .map(function (v) { return v ? new Date(v).getTime() : NaN; })
        .filter(function (v) { return !isNaN(v) && v > now; });
      return t.length ? Math.min.apply(null, t) : NaN;
    })
    .filter(function (v) { return !isNaN(v); });

  if (closes.length) {
    el.textContent = hhmmIST(new Date(Math.min.apply(null, closes)));
    if (label) label.textContent = closes.length > 1 ? 'Next close' : 'Closes';
    return;
  }
  el.textContent = (settings && settings.daily_cutoff) || el.textContent;
  if (label) label.textContent = 'Cut-off';
}

/**
 * The close this offer will actually be held to.
 *
 * The issue master carries the time somebody typed; bidding stops at the desk
 * cut-off, on every day the offer runs. Printing the typed time told an investor
 * an offer took bids until 05:15 PM and then refused them at 15:15. The server
 * sends the enforced close alongside the typed one; this reads it, and falls back
 * to the typed value so nothing renders blank.
 */
function closeOf(i, cat) {
  if (!i) return null;
  return cat === 'HNI' ? (i.hni_close_eff || i.hni_close)
                       : (i.ret_close_eff || i.ret_close);
}

/** When bidding on this offer stops today, or null once the offer is over. */
function stopsToday(i, cat) {
  if (!i) return null;
  return cat === 'HNI' ? (i.hni_stops_today || null) : (i.ret_stops_today || null);
}

/** HH:MM in Indian time, whatever the device is set to. */
function hhmmIST(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d);
}

function captureBidForms() {
  var out = {};
  Array.prototype.forEach.call(document.querySelectorAll('.bidbox'), function (box) {
    var id = box.getAttribute('data-bid-issue');
    if (!id || !DIRTY[id]) return;
    var vals = {};
    Array.prototype.forEach.call(box.querySelectorAll('[data-bf]'), function (el) {
      if (el.tagName === 'BUTTON') return;
      vals[el.getAttribute('data-bf')] = { value: el.value, disabled: !!el.disabled };
    });
    var a = document.activeElement;
    out[id] = {
      vals: vals,
      focus: a && box.contains(a) ? a.getAttribute('data-bf') : null,
      start: a && typeof a.selectionStart === 'number' ? a.selectionStart : null,
      end: a && typeof a.selectionEnd === 'number' ? a.selectionEnd : null
    };
  });
  return out;
}

function restoreBidForms(snap) {
  Object.keys(snap || {}).forEach(function (id) {
    var box = document.querySelector('.bidbox[data-bid-issue="' + id + '"]');
    if (!box) return;                                  // the offer closed; let it go
    var st = snap[id];
    Object.keys(st.vals).forEach(function (k) {
      var el = box.querySelector('[data-bf="' + k + '"]');
      if (!el || el.tagName === 'BUTTON') return;
      el.value = st.vals[k].value;
      if (el.tagName === 'INPUT') el.disabled = st.vals[k].disabled;
    });
    if (st.focus) {
      var back = box.querySelector('[data-bf="' + st.focus + '"]');
      if (back && back.focus) {
        back.focus();
        try {
          if (st.start != null && back.setSelectionRange) back.setSelectionRange(st.start, st.end);
        } catch (e) { /* a number input in some browsers - focus alone is enough */ }
      }
    }
  });
}

async function loadIssues(quiet) {
  try {
    var d = await api('/client/api/issues');
    SETTINGS = d.settings || {};
    var list = d.issues || [];
    BIDS_BY_ISSUE = {};
    ISSUES_BY_ID = {};
    list.forEach(function (i) {
      ISSUES_BY_ID[String(i.id)] = i;
      if (i.my_bid) BIDS_BY_ISSUE[String(i.id)] = i.my_bid;
    });
    showCutoff(list, d.settings || {});
    if ($('#issuesCount')) {
      $('#issuesCount').textContent = list.length
        ? inr(list.length, 0) + ' offer(s)' : '';
    }
    $('#clientIssues').innerHTML = list.length
      ? '<thead><tr><th>Scrip</th><th>Status</th><th class="n">Floor</th>' +
        '<th class="n">Retail min</th><th>Closes</th><th>Your bid</th><th></th></tr></thead>' +
        '<tbody>' + list.map(issueRow).join('') + '</tbody>'
      : '<tbody><tr><td class="tbl-empty">There is no open Offer for Sale right now. ' +
        'Issues appear here as soon as Ashika publishes them.</td></tr></tbody>';
    // The form lives on its own page and is redrawn there, keeping whatever is
    // half-typed in it — the list above carries no inputs to lose.
    renderPlace();
  } catch (e) {
    if (e.status === 401) return sessionLost();
    if (!quiet) toast('Could not load issues', e.message, 'bad');
  }
}

/**
 * Client-wise margin, on the client's own screen.
 *
 * The server sends one of two shapes and says which: a CLIENT gets their own
 * account, a branch or AP gets the totals across their book. The three figures are
 * the same three the desk sees, computed by the same code on the server, so an
 * investor ringing the desk about their margin and the desk looking it up are
 * reading one number.
 *
 *   Available  what the desk has loaded for today. Margins are cleared each
 *              morning and re-uploaded, so a stale timestamp against a non-zero
 *              figure is worth showing rather than hiding.
 *   Used       the value of live bids. A cancelled bid releases its hold.
 *   Free       what is left. Below zero means margin was reduced after bids went
 *              live — the investor has not done anything wrong, but the desk has
 *              to be told, so the card says so instead of showing a red number
 *              with no explanation.
 */
function renderMargin(m, branch) {
  var card = $('#marginCard');
  if (!card) return;
  if (!m) { card.classList.add('hide'); $('#marginSummary').textContent = ''; return; }
  card.classList.remove('hide');

  var book = m.scope === 'book';
  var free = Number(m.free) || 0;
  $('#marginTitle').textContent = book ? 'Margin across your clients' : 'My margin';
  $('#marginAt').textContent = book
    ? inr(m.clients || 0, 0) + ' client(s)'
    : (m.at ? 'As loaded ' + dt(m.at) : 'No margin loaded for today');

  function cell(k, v, s, cls) {
    return '<div class="mg-c ' + (cls || '') + '"><div class="k">' + esc(k) + '</div>' +
           '<div class="v">' + rupee(v, 0) + '</div>' +
           '<div class="s">' + esc(s || '') + '</div></div>';
  }
  $('#marginGrid').innerHTML =
    cell('Available', m.available, book ? 'Loaded for your clients' : 'Loaded by the desk today') +
    cell('Used', m.used, book
      ? (m.with_bids ? inr(m.with_bids, 0) + ' client(s) with live bids' : 'No live bids')
      : (m.live_bids ? 'Held against ' + inr(m.live_bids, 0) + ' live bid(s)' : 'No live bids')) +
    cell('Free', free, book ? 'Across the whole book' : 'What you can still bid with',
         free < 0 ? 'neg' : free > 0 ? 'pos' : '');

  var note = $('#marginNote');
  if (book && m.short) {
    note.className = 'note bad';
    note.textContent = inr(m.short, 0) + ' of your clients have live bids worth more than ' +
      'the margin loaded against them. Please speak to the OFS desk before the cut-off.';
  } else if (!book && free < 0) {
    note.className = 'note bad';
    note.textContent = 'Your live bids are worth more than the margin currently loaded ' +
      'against your account. Please contact the OFS desk before the cut-off.';
  } else if (!book && !Number(m.available)) {
    note.className = 'note';
    note.textContent = 'No margin has been loaded against your account yet today. ' +
      'Margins are set by the desk each morning — a bid cannot be placed until one is.';
  } else {
    note.className = 'note hide';
    note.textContent = '';
  }

  // The old one-line summary stays in the bids header for the at-a-glance read.
  $('#marginSummary').textContent = 'Free ' + rupee(free, 0) +
    ' of ' + rupee(m.available, 0);
}

/** Ten rows a page, server-side — a branch can hold hundreds of clients. */
var BIDS_PAGE = { offset: 0, limit: 10, total: 0 };

async function loadBids(offset) {
  BIDS_PAGE.offset = Math.max(0, offset == null ? BIDS_PAGE.offset : offset);
  try {
    var d = await api('/client/api/me/bids?limit=' + BIDS_PAGE.limit + '&offset=' + BIDS_PAGE.offset);
    var branch = d.actor && d.actor.kind !== 'client';
    BIDS_PAGE.total = d.total || 0;

    $('#bidsTitle').textContent = branch ? 'Bids — ' + (d.actor.branch_code || '') : 'My bids';
    renderMargin(d.margin || null, branch);

    var b = d.bids || [];
    var from = BIDS_PAGE.total ? BIDS_PAGE.offset + 1 : 0;
    var to = Math.min(BIDS_PAGE.offset + BIDS_PAGE.limit, BIDS_PAGE.total);
    $('#bidsCount').textContent = BIDS_PAGE.total
      ? from + '–' + to + ' of ' + BIDS_PAGE.total + ' bid(s)' : 'no bids yet';

    $('#myBidsTbl').innerHTML = b.length ? (
      '<thead><tr><th>Ref</th><th class="hide-stack">Scrip</th>' +
      (branch ? '<th>Client</th><th>Placed by</th>' : '') +
      '<th>Category</th>' +
      '<th class="n">Qty</th><th class="n">Price</th><th class="n">Value</th>' +
      '<th>Status</th><th>Placed</th><th></th></tr></thead><tbody>' +
      b.map(function (x) {
        return '<tr><td class="m rowhead"><b>' + esc(x.symbol || '') + '</b>' +
            '<span class="sub"> · ' + esc(x.ref) + '</span></td>' +
          '<td class="hide-stack"><b>' + esc(x.symbol || '') + '</b></td>' +
          (branch
            ? '<td class="m" data-label="Client">' + esc(x.client_ucc) +
              (x.client_name ? '<br><span class="cd">' + esc(x.client_name) + '</span>' : '') + '</td>' +
              // Whether the CLIENT placed it or the branch did is the distinction an
              // AP most needs when deciding whether to act.
              '<td data-label="Placed by"><span class="chip ' + (x.placed_by === 'client' ? 'open' : 'grey') + '">' +
                esc(placedByLabel(x.placed_by)) + '</span></td>'
            : '') +
          '<td data-label="Category"><span class="chip ' + (x.category === 'Retail' ? 'retail' : 'hni') + '">' +
            esc(x.category) + '</span></td>' +
          '<td class="n" data-label="Qty">' + inr(x.qty, 0) + '</td>' +
          '<td class="n" data-label="Price">' + (x.is_cutoff ? 'Cut-off' : inr(x.price, 2)) + '</td>' +
          '<td class="n" data-label="Value">' + inr(x.value, 0) + '</td>' +
          '<td data-label="Status"><span class="chip ' + (x.status === 'Live' ? 'open' : x.status === 'Cancelled' ? 'grey' : 'soon') +
            '">' + esc(x.status) + '</span></td>' +
          '<td class="m" data-label="Placed">' + dt(x.created_at) + '</td>' +
          /* Modify and Withdraw, on the screen the investor actually looks at.
           *
           * Both have always existed - on the issue card, under Open issues - so
           * an investor who came to My bids to change a bid found a read-only
           * list and concluded the portal could not do it. Modify carries them to
           * that card, which is where the floor, the tick and the cap are shown.
           * Neither is offered on a bid that is no longer live, nor on one whose
           * offer has closed. */
          '<td class="act" data-label="">' + (
            (x.status === 'Live' || x.status === 'Modified') && bidStillOpen(x)
              ? '<button class="btn btn-o btn-sm" data-bid-modify="' + esc(x.issue_id) + '">Modify</button> ' +
                '<button class="btn btn-o btn-sm" data-bid-cancel="' + esc(x.id) + '" ' +
                  'data-bid-ref="' + esc(x.ref) + '">Withdraw</button>'
              : '<span class="sub">—</span>'
          ) + '</td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="tbl-empty">' +
        (branch ? 'No bids for your clients yet.' : 'You have not placed a bid yet.') +
        '</td></tr></tbody>';

    $('#bidsPager').innerHTML = BIDS_PAGE.total > BIDS_PAGE.limit
      ? '<button class="btn btn-o btn-sm" id="bidsPrev"' + (BIDS_PAGE.offset <= 0 ? ' disabled' : '') + '>← Newer</button>' +
        '<button class="btn btn-o btn-sm" id="bidsNext"' + (to >= BIDS_PAGE.total ? ' disabled' : '') + '>Older →</button>'
      : '';
    if ($('#bidsPrev')) $('#bidsPrev').addEventListener('click', function () {
      loadBids(BIDS_PAGE.offset - BIDS_PAGE.limit);
    });
    if ($('#bidsNext')) $('#bidsNext').addEventListener('click', function () {
      loadBids(BIDS_PAGE.offset + BIDS_PAGE.limit);
    });
  } catch (e) {
    if (e.status === 401) return sessionLost();
    toast('Could not load bids', e.message, 'bad');
  }
}

function placedByLabel(v) {
  return v === 'desk' ? 'Back office' : v === 'client' ? 'Client'
       : v === 'ap' ? 'AP' : v === 'branch' ? 'Branch' : (v || '');
}

/**
 * The list on screen as a file. Built from the API rather than from the drawn rows,
 * so it carries every field and every page — a CSV of what happened to be visible is
 * not a record of anything.
 */
async function downloadBidsCsv() {
  var btn = $('#bidsCsv');
  btn.disabled = true;
  try {
    var d = await api('/client/api/me/bids?all=1');
    var rows = d.bids || [];
    if (!rows.length) { toast('Nothing to download', 'There are no bids yet.', 'warn'); return; }
    var head = ['Ref', 'Client UCC', 'Client', 'Branch', 'Placed by', 'Symbol', 'ISIN', 'Exchange',
                'Category', 'Bid type', 'Quantity', 'Price', 'Value', 'Status', 'Reject reason',
                'Confirmed by OTP', 'Placed at', 'Last changed'];
    var cell = function (v) {
      var t = v == null ? '' : String(v);
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    var lines = [head.join(',')].concat(rows.map(function (x) {
      return [x.ref, x.client_ucc, x.client_name || '', x.branch_code || '', placedByLabel(x.placed_by),
              x.symbol || '', x.isin || '', x.exchange || '', x.category,
              x.is_cutoff ? 'Cut-off' : 'Limit', x.qty, x.is_cutoff ? '' : x.price, x.value,
              x.status, x.reject_reason || '', x.otp_verified ? 'Yes' : 'No',
              x.created_at, x.updated_at].map(cell).join(',');
    }));
    var name = 'OFS_Bids_' + ((d.actor && (d.actor.branch_code || d.actor.ucc)) || 'me') + '_' +
               new Date().toISOString().slice(0, 10) + '.csv';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('Downloaded', rows.length + ' bid(s), all fields.', 'ok');
  } catch (e) {
    if (e.status === 401) return sessionLost();
    toast('Download failed', e.message, 'bad');
  } finally { btn.disabled = false; }
}

/** What this client was allotted, once the desk has imported the exchange file. */
async function loadAllotments() {
  try {
    var d = await api('/client/api/me/allotments');
    var a = d.allotments || [];
    $('#myAllotTbl').innerHTML = a.length ? (
      '<thead><tr><th>Scrip</th><th class="n">Allotted</th><th class="n">Price</th>' +
      '<th class="n">Value</th><th>Date</th></tr></thead><tbody>' +
      a.map(function (x) {
        return '<tr><td class="rowhead"><b>' + esc(x.symbol || '') + '</b><br>' +
          '<span class="cd" style="font-size:11px;color:var(--muted)">' + esc(x.company || '') + '</span></td>' +
          '<td class="n" data-label="Allotted">' + inr(x.allot_qty, 0) + '</td>' +
          '<td class="n" data-label="Price">' + (x.allot_price == null ? '—' : inr(x.allot_price, 2)) + '</td>' +
          '<td class="n" data-label="Value">' + inr(x.allot_value, 0) + '</td>' +
          '<td class="m" data-label="Date">' + dt(x.allotted_at) + '</td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="tbl-empty">No allotments yet. ' +
        'Results appear here once the exchange file has been processed.</td></tr></tbody>';
  } catch (e) {
    if (e.status === 401) return sessionLost();
    toast('Could not load allotments', e.message, 'bad');
  }
}

function sessionLost() {
  showIdentifier(null);
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
  /* --------------------------------------------------------------- the two doors --
   * A client signs in with whatever they have; a branch with the address on its LD
   * record. Same card, because a second URL is a second thing to get wrong.
   */
  $$('#doorTabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      var door = b.dataset.door;
      $$('#doorTabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      show($('#paneDetails'), door === 'client');
      show($('#paneBranch'), door === 'branch');
      $('#loginSub').textContent = door === 'branch'
        ? 'Sign in with the email registered for your branch or AP code'
        : 'Sign in with your client code, registered mobile or email';
      (door === 'branch' ? $('#brEmail') : $('#idInput')).focus();
    });
  });
  $('#brEmail').addEventListener('input', function () {
    var ok = EMAIL_RE.test($('#brEmail').value.trim());
    $('#brSendBtn').disabled = !ok;
    // The tick is driven by a class on the FIELD, not on the tick itself (style.css).
    $('#brEmail').parentNode.classList.toggle('valid', ok);
  });
  $('#paneBranch').addEventListener('submit', function (e) { e.preventDefault(); sendBranchCode(); });

  $('#paneDetails').addEventListener('submit', function (e) { e.preventDefault(); sendCode(); });
  $('#idInput').addEventListener('input', refreshDetails);
  $('#idInput').addEventListener('blur', refreshDetails);
  refreshDetails();
  $('#verifyBtn').addEventListener('click', verifyCode);
  $('#otpBackBtn').addEventListener('click', backToDetails);
  $('#resendBtn').addEventListener('click', sendCode);
  $('#acctList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ucc]');
    if (b) chooseAccount(b.dataset.ucc);
  });
  $('#signOutBtn').addEventListener('click', signOut);
  $('#bidsCsv').addEventListener('click', downloadBidsCsv);
  // The bids table is rebuilt on every load, so delegate from its container.
  $('#myBidsTbl').addEventListener('click', function (e) {
    var m = e.target.closest('[data-bid-modify]');
    if (m) { e.preventDefault(); return modifyFromList(m.getAttribute('data-bid-modify')); }
    var c = e.target.closest('[data-bid-cancel]');
    if (c) {
      e.preventDefault();
      withdrawFromList(c.getAttribute('data-bid-cancel'), c.getAttribute('data-bid-ref'));
    }
  });
  $$('#cTabs button').forEach(function (b) {
    b.addEventListener('click', function () { showCTab(b.dataset.ctab); });
  });

  // Bid forms are rebuilt on every refresh of the issue list, so delegate from the
  // container rather than re-binding after each render.
  $('#clientIssues').addEventListener('click', function (e) {
    var go = e.target.closest('[data-place]');
    if (go) { e.preventDefault(); openPlace(go.getAttribute('data-place')); }
  });

  $('#cpForm').addEventListener('input', function (e) {
    var box = e.target.closest('.bidbox');
    if (box && e.target.matches('[data-bf]')) {
      DIRTY[box.getAttribute('data-bid-issue')] = true;
      recalcTotal();
    }
  });
  $('#cpForm').addEventListener('change', function (e) {
    var box = e.target.closest('.bidbox');
    if (!box) return;
    if (e.target.matches('[data-bf]')) DIRTY[box.getAttribute('data-bid-issue')] = true;
    // The category matters as well as the type: a cut-off bid switched from
    // Retail to HNI is priced at the floor, not at the retail minimum.
    if (e.target.matches('[data-bf="type"]') || e.target.matches('[data-bf="cat"]')) {
      applyPriceMode(box);
    }
    recalcTotal();
  });
  $('#cpForm').addEventListener('click', function (e) {
    var box = e.target.closest('.bidbox');
    if (!box) return;
    if (e.target.closest('[data-bf="back"]'))   { e.preventDefault(); showCTab('issues'); return; }
    if (e.target.closest('[data-bf="fill"]'))   {
      e.preventDefault();
      fillSuggested(box);
      DIRTY[box.getAttribute('data-bid-issue')] = true;
      recalcTotal();
      return;
    }
    if (e.target.closest('[data-bf="check"]'))  { e.preventDefault(); checkBid(box); return; }
    if (e.target.closest('[data-bf="submit"]')) {
      e.preventDefault();
      // Acted on, so the next refresh may bring the server's copy back.
      delete DIRTY[box.getAttribute('data-bid-issue')];
      submitBid(box, null);
      return;
    }
    if (e.target.closest('[data-bf="cancel"]')) {
      e.preventDefault();
      delete DIRTY[box.getAttribute('data-bid-issue')];
      withdrawBid(box);
    }
  });
  // Typed in, so a background refresh must not overwrite it.
  $('#clientIssues').addEventListener('input', function (e) {
    var box = e.target.closest('.bidbox');
    if (box && e.target.matches('[data-bf]')) DIRTY[box.getAttribute('data-bid-issue')] = true;
  });
  $('#clientIssues').addEventListener('change', function (e) {
    var box = e.target.closest('.bidbox');
    if (!box) return;
    if (e.target.matches('[data-bf]')) DIRTY[box.getAttribute('data-bid-issue')] = true;
    // A cut-off bid's price is the offer's, not the investor's — shown, readonly.
    if (e.target.matches('[data-bf="type"]') || e.target.matches('[data-bf="cat"]')) {
      applyPriceMode(box);
    }
  });

  bindRulesLink();
  window.addEventListener('hashchange', restoreCTabFromHash);

  setInterval(tickClocks, 1000);

  // Already signed in? Skip the login stage entirely.
  try {
    var me = await api('/client/auth/me');
    S.client = me.client;
    enterApp();
  } catch (e) { /* not signed in — the login stage is already showing */ }
}

document.addEventListener('DOMContentLoaded', boot);
