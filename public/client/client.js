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

  S.branch = r.branch;
  S.client = { name: r.branch.name, ucc: r.branch.code };
  enterApp();
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
      : kind === 'ucc' ? 'Recognised as a client code.'
      : 'Use whichever you have — it must match your Ashika account.';
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
    hint.textContent = 'Enter your client code, your registered mobile number, or your registered email address.';
    $('#idInput').setAttribute('aria-invalid', 'true'); $('#idInput').focus(); return;
  }
  hint.className = 'hint';

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
    hint.className = 'hint bad';
    hint.textContent = (e.body && e.body.message) || e.message || 'Could not send a code just now.';
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
}

/* ---------------- signed in ---------------- */
function enterApp() {
  var c = S.client || {};
  var br = S.branch || null;
  $('#loginStage').classList.add('hide');
  $('#app').classList.remove('hide');
  $('#clientAv').textContent = initials(br ? br.code : c.name);
  $('#clientName').textContent = br ? (br.name || br.code) : (c.name || 'Client');
  $('#clientUcc').textContent = br
    ? br.type_label + ' ' + br.code + ' · ' + br.client_count + ' client(s)'
    : (c.ucc || '');
  // A branch has clients; a client does not. Naming the tab "My bids" for a branch
  // holding two hundred clients is wrong in a way that matters.
  show($('#tabClients'), !!br);
  $('#tabBids').textContent = br ? 'Bids' : 'My bids';
  setStep(3);
  loadIssues();
  loadBids(0);
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(function () { loadIssues(true); }, 15000);
}

function showCTab(t) {
  S.tab = t;
  var rl = $('#rulesLink');
  if (rl) rl.addEventListener('click', function (e) {
    e.preventDefault();
    var box = $('#loginRules');
    var open = !box.classList.contains('hide');
    if (open) { box.classList.add('hide'); rl.textContent = 'Read the bidding rules'; return; }
    renderRules(box);
    box.classList.remove('hide');
    rl.textContent = 'Hide the bidding rules';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $$('#cTabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.ctab === t); });
  ['issues', 'bids', 'clients', 'allot', 'rules'].forEach(function (k) {
    var el = $('#cpane-' + k);
    if (el) el.classList.toggle('hide', k !== t);
  });
  if (t === 'bids') loadBids(0);
  if (t === 'clients') loadClients();
  if (t === 'allot') loadAllotments();
  if (t === 'rules') renderRules($('#rulesBox'));
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
    bidBox(i, mine, retOpen, hniOpen) +
    '<div class="cdn" data-close="' + close.toISOString() + '">—</div>' +
  '</div>';
}

/* -------------------------------------------------------------- bidding UI --
 * The form only appears while a category is actually open. Every number typed
 * here is checked again on the server against the same rules the desk runs, so
 * this is for telling the client early — not for deciding anything.
 */
function bidBox(i, mine, retOpen, hniOpen) {
  if (!retOpen && !hniOpen) {
    return '<div class="note" style="margin-top:11px">Bidding is closed for this offer.</div>';
  }
  var id = i.id;
  var branch = !!S.branch;
  var cats = [];
  if (retOpen) cats.push('Retail');
  if (hniOpen) cats.push('HNI');
  var sel = mine && cats.indexOf(mine.category) >= 0 ? mine.category : cats[0];

  return '<div class="bidbox" data-bid-issue="' + id + '">' +
    (branch
      ? '<div class="bb-head">Bid for a client ' +
        '<span class="bb-sub">the client confirms with a code sent to them</span></div>'
      : mine
        ? '<div class="bb-head">Change your bid <span class="bb-sub">allowed until the cut-off</span></div>'
        : '<div class="bb-head">Place a bid</div>') +
    (branch
      ? '<div class="bb-row"><label class="bb-f" style="grid-column:1/-1"><span>Client UCC</span>' +
        '<input type="text" data-bf="ucc" placeholder="One of your clients" autocomplete="off"></label></div>'
      : '') +
    '<div class="bb-row">' +
      (cats.length > 1
        ? '<label class="bb-f"><span>Category</span><select data-bf="cat">' +
          cats.map(function (c) {
            return '<option value="' + c + '"' + (c === sel ? ' selected' : '') + '>' + c + '</option>';
          }).join('') + '</select></label>'
        : '<label class="bb-f"><span>Category</span><input type="text" value="' + esc(sel) +
          '" data-bf="cat" readonly></label>') +
      '<label class="bb-f"><span>Quantity</span>' +
        '<input type="number" min="' + (Number(i.lot) || 1) + '" step="' + (Number(i.lot) || 1) +
        '" data-bf="qty" value="' + (mine ? Number(mine.qty) : '') + '" placeholder="Shares"></label>' +
      '<label class="bb-f"><span>Bid type</span><select data-bf="type">' +
        '<option value="cutoff"' + (mine && mine.is_cutoff ? ' selected' : '') + '>Cut-off price</option>' +
        '<option value="limit"' + (mine && !mine.is_cutoff ? ' selected' : '') + '>My own price</option>' +
      '</select></label>' +
      '<label class="bb-f"><span>Price</span>' +
        '<input type="number" min="0" step="' + (Number(i.tick) || 0.05) + '" data-bf="price" ' +
        (mine && !mine.is_cutoff ? 'value="' + Number(mine.price) + '" ' : '') +
        (mine && !mine.is_cutoff ? '' : 'disabled ') + 'placeholder="At or above floor"></label>' +
    '</div>' +
    '<div class="bb-verdict" data-bf="verdict"></div>' +
    '<div class="bb-actions">' +
      '<button class="btn btn-o btn-sm" data-bf="check">Check</button>' +
      '<button class="btn btn-p btn-sm" data-bf="submit">' +
        (branch ? 'Place bid' : mine ? 'Update bid' : 'Place bid') + '</button>' +
      (mine && !branch ? '<button class="btn btn-o btn-sm" data-bf="cancel">Withdraw</button>' : '') +
    '</div>' +
  '</div>';
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
    price: cutoff ? null : Number(g('price').value) || 0
  };
  // A branch nominates the client; a client never does — their session decides.
  if (S.branch && g('ucc')) body.client_ucc = g('ucc').value.trim().toUpperCase();
  return body;
}

/** Which API this session bids through. */
function bidBase() { return S.branch ? '/client/api/branch/bids' : '/client/api/bids'; }

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
  // A branch bids for a named client, so BIDS_BY_ISSUE — which is keyed by issue —
  // is not "the bid being edited". Only a client session edits in place here.
  var editing = S.branch ? null : BIDS_BY_ISSUE[body.issue_id];
  var btn = box.querySelector('[data-bf="submit"]');
  if (otp) { body.otp_ref = otp.ref; body.otp = otp.code; }
  btn.disabled = true;
  try {
    if (editing) {
      await api(bidBase() + '/' + editing.id, { method: 'PUT', body: body });
      toast('Bid updated', 'Your bid has been changed.', 'ok');
    } else {
      await api(bidBase(), { method: 'POST', body: body });
      toast('Bid placed', S.branch
        ? 'Placed for ' + body.client_ucc + ', confirmed by the client.'
        : 'Your bid is with the desk.', 'ok');
    }
    hideBidOtp(box);
    await loadIssues();
    if (S.branch) loadBids(0);
  } catch (e) {
    if (e.status === 401) return sessionLost();
    if (e.status === 428 && e.body && e.body.error === 'otp_required') {
      return showBidOtp(box, body, e.body.action || 'place');
    }
    var errs = (e.body && e.body.errors) || [(e.body && e.body.message) || e.message];
    showVerdict(box, 'bad', errs);
    toast(editing ? 'Bid not updated' : 'Bid not placed', errs[0], 'bad');
  } finally { btn.disabled = false; }
}

/* --------------------------------------------------- the client's confirmation --
 * A branch does not place a bid on its own say-so. The code goes to the CLIENT's
 * registered mobile and email, and the branch types back what the client tells them.
 */
function hideBidOtp(box) {
  var el = box.querySelector('.bb-otp');
  if (el) el.remove();
}

function showBidOtp(box, body, action) {
  hideBidOtp(box);
  var el = document.createElement('div');
  el.className = 'bb-otp';
  el.innerHTML =
    '<b>' + esc(body.client_ucc || 'The client') + ' must confirm this.</b><br>' +
    'A one-time code goes to their registered mobile and email — not to you.' +
    '<div class="bb-actions" style="margin-top:9px">' +
      '<button class="btn btn-o btn-sm" data-otp="send">Send code to client</button>' +
      '<input type="text" data-otp="code" inputmode="numeric" maxlength="6" ' +
        'placeholder="6-digit code" style="flex:0 1 150px" disabled>' +
      '<button class="btn btn-p btn-sm" data-otp="go" disabled>Confirm and place</button>' +
    '</div><div class="bb-otp-note" data-otp="note"></div>';
  box.appendChild(el);

  var note = el.querySelector('[data-otp="note"]');
  var ref = null;

  el.querySelector('[data-otp="send"]').addEventListener('click', async function () {
    var b = this;
    b.disabled = true;
    try {
      var r = await api('/client/api/branch/bids/otp', { method: 'POST', body: {
        client_ucc: body.client_ucc, issue_id: body.issue_id, action: action,
        detail: inr(body.qty, 0) + ' shares at ' + (body.is_cutoff ? 'cut-off' : rupee(body.price)) } });
      ref = r.ref;
      el.querySelector('[data-otp="code"]').disabled = false;
      el.querySelector('[data-otp="go"]').disabled = false;
      el.querySelector('[data-otp="code"]').focus();
      note.innerHTML = 'Sent to ' + esc(r.sent_to) + ' · valid ' + r.ttl_minutes + ' minutes.' +
        (r.test_code ? ' <b>Test mode: ' + esc(r.test_code) + '</b>' : '');
    } catch (e) {
      note.textContent = (e.body && e.body.message) || e.message;
    } finally { b.disabled = false; }
  });

  var go = function () {
    var code = el.querySelector('[data-otp="code"]').value.replace(/\D/g, '');
    if (!ref || code.length !== 6) { note.textContent = 'Enter the 6-digit code the client received.'; return; }
    submitBid(box, { ref: ref, code: code });
  };
  el.querySelector('[data-otp="go"]').addEventListener('click', go);
  el.querySelector('[data-otp="code"]').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') go();
  });
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

var BIDS_BY_ISSUE = {};

async function loadIssues(quiet) {
  try {
    var d = await api('/client/api/issues');
    if (d.settings && d.settings.daily_cutoff) $('#cutTime').textContent = d.settings.daily_cutoff;
    var list = d.issues || [];
    BIDS_BY_ISSUE = {};
    list.forEach(function (i) { if (i.my_bid) BIDS_BY_ISSUE[String(i.id)] = i.my_bid; });
    $('#clientIssues').innerHTML = list.length
      ? list.map(issueCard).join('')
      : '<div class="tbl-empty">There is no open Offer for Sale right now. ' +
        'Issues appear here as soon as Ashika publishes them.</div>';
    // A client chosen on My clients is carried across to whichever bid box is
    // rendered here, so the UCC never has to be typed twice.
    applyPendingUcc();
  } catch (e) {
    if (e.status === 401) return sessionLost();
    if (!quiet) toast('Could not load issues', e.message, 'bad');
  }
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
    var m = d.margin || null;
    $('#marginSummary').textContent = m
      ? 'Available ' + rupee(m.available, 0) + ' · used ' + rupee(m.used, 0) + ' · free ' + rupee(m.free, 0)
      : (branch ? 'Margin is held per client — open a client to see theirs.' : '');

    var b = d.bids || [];
    var from = BIDS_PAGE.total ? BIDS_PAGE.offset + 1 : 0;
    var to = Math.min(BIDS_PAGE.offset + BIDS_PAGE.limit, BIDS_PAGE.total);
    $('#bidsCount').textContent = BIDS_PAGE.total
      ? from + '–' + to + ' of ' + BIDS_PAGE.total + ' bid(s)' : 'no bids yet';

    $('#myBidsTbl').innerHTML = b.length ? (
      '<thead><tr><th>Ref</th><th>Scrip</th>' +
      (branch ? '<th>Client</th><th>Placed by</th>' : '') +
      '<th>Category</th>' +
      '<th class="n">Qty</th><th class="n">Price</th><th class="n">Value</th>' +
      '<th>Status</th><th>Placed</th></tr></thead><tbody>' +
      b.map(function (x) {
        return '<tr><td class="m">' + esc(x.ref) + '</td>' +
          '<td><b>' + esc(x.symbol || '') + '</b></td>' +
          (branch
            ? '<td class="m">' + esc(x.client_ucc) +
              (x.client_name ? '<br><span class="cd">' + esc(x.client_name) + '</span>' : '') + '</td>' +
              // Whether the CLIENT placed it or the branch did is the distinction an
              // AP most needs when deciding whether to act.
              '<td><span class="chip ' + (x.placed_by === 'client' ? 'open' : 'grey') + '">' +
                esc(placedByLabel(x.placed_by)) + '</span></td>'
            : '') +
          '<td><span class="chip ' + (x.category === 'Retail' ? 'retail' : 'hni') + '">' +
            esc(x.category) + '</span></td>' +
          '<td class="n">' + inr(x.qty, 0) + '</td>' +
          '<td class="n">' + (x.is_cutoff ? 'Cut-off' : inr(x.price, 2)) + '</td>' +
          '<td class="n">' + inr(x.value, 0) + '</td>' +
          '<td><span class="chip ' + (x.status === 'Live' ? 'open' : x.status === 'Cancelled' ? 'grey' : 'soon') +
            '">' + esc(x.status) + '</span></td>' +
          '<td class="m">' + dt(x.created_at) + '</td></tr>';
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

/** The clients this branch may act for. */
/* --------------------------------------------------------------- my clients --
 * Paged on the server, ten at a time, with a Bid button on every row.
 *
 * The list used to render every client the branch has and stop there: 121 rows of
 * scrolling, and then you had to remember the UCC, switch to Open issues and type
 * it in by hand. The button carries the UCC across, which is the only thing that
 * screen was being used to look up.
 */
var CL = { offset: 0, limit: 10, q: '', total: 0 };

async function loadClients(reset) {
  if (reset) CL.offset = 0;
  CL.q = ($('#clQ').value || '').trim();
  try {
    var qs = 'limit=' + CL.limit + '&offset=' + CL.offset + (CL.q ? '&q=' + encodeURIComponent(CL.q) : '');
    var d = await api('/client/api/me/clients?' + qs);
    var list = d.clients || [];
    CL.total = Number(d.total) || 0;

    // "121 client(s)" is the whole book; on a filtered or paged view the desk also
    // needs to know which of them is on the screen.
    var from = CL.total ? CL.offset + 1 : 0;
    var to = Math.min(CL.offset + CL.limit, CL.total);
    $('#clCount').textContent = CL.total
      ? from + '–' + to + ' of ' + CL.total + (CL.q ? ' matching' : '') + ' client(s)'
      : (CL.q ? 'no client matches “' + CL.q + '”' : 'no clients');

    $('#clientTbl').innerHTML = list.length ? (
      '<thead><tr><th>UCC</th><th>Name</th><th>Category</th><th>Status</th><th></th></tr></thead><tbody>' +
      list.map(function (c) {
        return '<tr><td class="m">' + esc(c.ucc) + '</td>' +
          '<td>' + esc(c.name || '—') + '</td>' +
          '<td>' + esc(c.category || '—') + '</td>' +
          '<td><span class="chip ' + (c.active ? 'open' : 'grey') + '">' +
            (c.active ? 'Active' : 'Inactive') + '</span></td>' +
          // Only an active client can be bid for, so an inactive row says why
          // rather than offering a button that leads to a refusal.
          '<td class="act">' + (c.active
            ? '<button class="btn btn-o btn-sm" data-bidfor="' + esc(c.ucc) + '">Place bid</button>'
            : '<span class="cl-no">cannot bid</span>') + '</td></tr>';
      }).join('') + '</tbody>'
    ) : ('<tbody><tr><td class="tbl-empty">' +
         (CL.q ? 'No client matches that search.' : 'No clients are mapped to your branch.') +
         '</td></tr></tbody>');

    renderClPager();
  } catch (e) {
    if (e.status === 401) return sessionLost();
    toast('Could not load clients', e.message, 'bad');
  }
}

function renderClPager() {
  var el = $('#clPager');
  if (!el) return;
  var pages = Math.max(1, Math.ceil(CL.total / CL.limit));
  var page = Math.floor(CL.offset / CL.limit) + 1;
  if (CL.total <= CL.limit) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<button class="btn btn-o btn-sm" data-clpage="prev"' + (CL.offset <= 0 ? ' disabled' : '') + '>Previous</button>' +
    '<span class="tag">Page ' + page + ' of ' + pages + '</span>' +
    '<button class="btn btn-o btn-sm" data-clpage="next"' +
      (CL.offset + CL.limit >= CL.total ? ' disabled' : '') + '>Next</button>';
}

/**
 * Jump to Open issues with this client already filled in.
 *
 * If exactly one issue is open it opens that bid box outright; with more than one
 * there is nothing to guess, so the UCC is remembered and applied to whichever box
 * the branch opens next.
 */
function bidForClient(ucc) {
  PENDING_UCC = String(ucc || '').trim().toUpperCase();
  showTab('issues');
  applyPendingUcc();
  toast('Bidding for ' + PENDING_UCC, 'Choose the offer, then place the bid.', 'ok');
}
var PENDING_UCC = '';
function applyPendingUcc() {
  if (!PENDING_UCC) return;
  var f = $('[data-bf="ucc"]');
  if (!f) return;                       // no bid box open yet; applied when one is
  f.value = PENDING_UCC;
  f.dispatchEvent(new Event('input', { bubbles: true }));
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
  // reset:true on every new search — staying on page 7 of a list that now has two
  // rows shows an empty table and looks like the search found nothing.
  $('#clGo').addEventListener('click', function () { loadClients(true); });
  $('#clQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadClients(true); });
  $('#clClear').addEventListener('click', function () { $('#clQ').value = ''; loadClients(true); });
  $('#clPager').addEventListener('click', function (e) {
    var b = e.target.closest('[data-clpage]');
    if (!b || b.disabled) return;
    CL.offset = Math.max(0, CL.offset + (b.dataset.clpage === 'next' ? CL.limit : -CL.limit));
    loadClients();
  });
  $('#clientTbl').addEventListener('click', function (e) {
    var b = e.target.closest('[data-bidfor]');
    if (b) bidForClient(b.dataset.bidfor);
  });
  $$('#cTabs button').forEach(function (b) {
    b.addEventListener('click', function () { showCTab(b.dataset.ctab); });
  });

  // Bid forms are rebuilt on every refresh of the issue list, so delegate from the
  // container rather than re-binding after each render.
  $('#clientIssues').addEventListener('click', function (e) {
    var box = e.target.closest('.bidbox');
    if (!box) return;
    if (e.target.closest('[data-bf="check"]'))  { e.preventDefault(); checkBid(box); return; }
    if (e.target.closest('[data-bf="submit"]')) { e.preventDefault(); submitBid(box, null); return; }
    if (e.target.closest('[data-bf="cancel"]')) { e.preventDefault(); withdrawBid(box); }
  });
  $('#clientIssues').addEventListener('change', function (e) {
    var box = e.target.closest('.bidbox');
    if (!box) return;
    // A cut-off bid has no price of its own; leaving the field live would invite a
    // number that is then silently discarded.
    if (e.target.matches('[data-bf="type"]')) {
      var price = box.querySelector('[data-bf="price"]');
      price.disabled = e.target.value === 'cutoff';
      if (price.disabled) price.value = '';
    }
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
