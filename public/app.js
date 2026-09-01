'use strict';
/* OFS desk UI. CSP-safe: no inline script, no external CDN, no chart library. */

var $  = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

var TOKEN = null;                      // set by the host shell; falls back to the cookie session
var STATE = { dash: null, issues: [], timer: null, tab: 'dash', mtab: 'issues' };

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
function crore(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e7) return '₹' + inr(n / 1e7, 2) + ' Cr';
  if (Math.abs(n) >= 1e5) return '₹' + inr(n / 1e5, 2) + ' L';
  return rupee(n, 0);
}
function dt(v) {
  if (!v) return '—';
  var d = new Date(v);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
function hms(ms) {
  if (ms <= 0) return '00:00:00';
  var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  var p = function (x) { return String(x).padStart(2, '0'); };
  return p(h) + ':' + p(m) + ':' + p(s % 60);
}
function chipCls(st) {
  if (/open/i.test(st)) return 'open';
  if (/upcoming/i.test(st)) return 'soon';
  return 'closed';
}
function statusCls(s) {
  return s === 'Live' ? 'live' : s === 'Cancelled' ? 'canc' : s === 'Rejected' ? 'rej' : 'mod';
}
function toast(title, msg, kind) {
  var box = document.createElement('div');
  if (kind) box.className = kind;
  box.innerHTML = '<b>' + esc(title) + '</b><p>' + esc(msg || '') + '</p>';
  $('#toast').appendChild(box);
  setTimeout(function () { box.remove(); }, 6000);
}

/* ---------------- api ---------------- */
async function api(path, opts) {
  opts = opts || {};
  var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  var res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: headers,
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  var text = await res.text();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
  if (!res.ok) { var err = new Error((json && json.error) || res.statusText); err.status = res.status; err.body = json; throw err; }
  return json;
}

/* ---------------- tabs ---------------- */
function showTab(t) {
  STATE.tab = t;
  $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
  ['dash', 'book', 'place', 'export', 'masters'].forEach(function (k) {
    $('#pane-' + k).classList.toggle('hide', k !== t);
  });
  if (t === 'book') loadBook();
  if (t === 'export') { loadExportLog(); previewExport(); }
  if (t === 'masters') loadMasters();
}

/* ---------------- dashboard ---------------- */
function kpiCard(k, v, s) {
  return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' +
         '<div class="s">' + esc(s || '') + '</div></div>';
}

function issueCard(i) {
  var total = Number(i.total_value) || 0;
  var rv = Number(i.ret_value) || 0, hv = Number(i.hni_value) || 0;
  var pr = total ? (rv / total * 100) : 0, ph = total ? (hv / total * 100) : 0;
  var close = new Date(Math.max(new Date(i.hni_close), new Date(i.ret_close)));
  var nextClose = i.hni_status === 'Open' ? new Date(i.hni_close)
                : i.ret_status === 'Open' ? new Date(i.ret_close) : close;
  return '' +
  '<div class="card" data-issue="' + i.id + '">' +
    '<div class="hd">' +
      '<div style="flex:1">' +
        '<div class="sym">' + esc(i.symbol) + '</div>' +
        '<div class="co">' + esc(i.company) + '</div>' +
        '<div class="isin">' + esc(i.isin) + ' · ' + esc(i.exchange) + '</div>' +
      '</div>' +
      '<span class="chip ' + chipCls(i.status_label) + '">' + esc(i.status_label) + '</span>' +
    '</div>' +
    '<div class="grid2">' +
      '<div class="f"><div class="k">Floor</div><div class="v">' + rupee(i.floor_price) + '</div></div>' +
      '<div class="f"><div class="k">Retail cut-off min</div><div class="v">' + rupee(i.min_price_retail) + '</div></div>' +
      '<div class="f"><div class="k">Bids</div><div class="v">' + inr(i.bid_count, 0) + ' · ' + inr(i.client_count, 0) + ' clients</div></div>' +
      '<div class="f"><div class="k">Quantity</div><div class="v">' + inr(i.total_qty, 0) + '</div></div>' +
      '<div class="f"><div class="k">Value</div><div class="v">' + crore(total) + '</div></div>' +
      '<div class="f"><div class="k">Subscription</div><div class="v">' +
        (i.subscription_x == null ? '—' : inr(i.subscription_x, 2) + '×') + '</div></div>' +
    '</div>' +
    '<div class="split"><i class="r" style="width:' + pr.toFixed(1) + '%"></i><i class="h" style="width:' + ph.toFixed(1) + '%"></i></div>' +
    '<div class="legend">' +
      '<span><i class="dot r"></i>Retail <b>' + crore(rv) + '</b> · ' + esc(i.ret_status) + '</span>' +
      '<span><i class="dot h"></i>HNI <b>' + crore(hv) + '</b> · ' + esc(i.hni_status) + '</span>' +
    '</div>' +
    (i.our_vwap != null ? '<div class="legend"><span>Our book VWAP <b>' + rupee(i.our_vwap) + '</b></span></div>' : '') +
    '<div class="cdn" data-close="' + nextClose.toISOString() + '">closes in --:--:--</div>' +
  '</div>';
}

function renderDash(d) {
  var t = d.totals || {};
  $('#kpis').innerHTML =
    kpiCard('Open issues', String((d.issues || []).filter(function (i) { return /open/i.test(i.status_label); }).length), 'of ' + (d.issues || []).length + ' tracked') +
    kpiCard('Live bids', inr(t.bids, 0), inr(t.clients, 0) + ' clients') +
    kpiCard('Total quantity', inr(t.qty, 0), 'shares bid') +
    kpiCard('Total value', crore(t.value), 'across all issues') +
    kpiCard('Desk cut-off', esc((d.settings && d.settings.daily_cutoff) || '15:15'), 'IST daily');

  $('#issueCards').innerHTML = (d.issues || []).length
    ? d.issues.map(issueCard).join('')
    : '<div class="empty">No open OFS issue. Add one under Masters → Issues.</div>';

  var r = d.recent || [];
  $('#recentTbl').innerHTML = r.length ? (
    '<thead><tr><th>Time</th><th>Ref</th><th>Symbol</th><th>UCC</th><th>Cat</th>' +
    '<th class="n">Qty</th><th class="n">Price</th><th class="n">Value</th><th>Status</th></tr></thead><tbody>' +
    r.map(function (b) {
      return '<tr><td class="m">' + dt(b.created_at) + '</td><td class="m">' + esc(b.ref) + '</td>' +
        '<td>' + esc(b.symbol || '') + '</td><td class="m">' + esc(b.client_ucc) + '</td>' +
        '<td><span class="tag ' + (b.category === 'Retail' ? 'ret' : 'hni') + '">' + esc(b.category) + '</span></td>' +
        '<td class="n">' + inr(b.qty, 0) + '</td>' +
        '<td class="n">' + (b.is_cutoff ? 'Cut-off' : inr(b.price, 2)) + '</td>' +
        '<td class="n">' + inr(b.value, 0) + '</td>' +
        '<td><span class="st ' + statusCls(b.status) + '">' + esc(b.status) + '</span></td></tr>';
    }).join('') + '</tbody>'
  ) : '<tbody><tr><td class="empty">No bids yet.</td></tr></tbody>';
}

async function loadDash() {
  try {
    var d = await api('/dashboard');
    STATE.dash = d;
    STATE.issues = d.issues || [];
    renderDash(d);
    fillIssueSelects();
  } catch (e) {
    if (e.status === 401) toast('Not signed in', 'This desk needs a platform session with the ofs-desk grant.', 'bad');
    else toast('Dashboard failed', e.message, 'bad');
  }
}

function fillIssueSelects() {
  var opts = STATE.issues.map(function (i) {
    return '<option value="' + i.id + '">' + esc(i.symbol) + ' — ' + esc(i.company) + '</option>';
  }).join('');
  ['#bkIssue', '#exIssue'].forEach(function (sel) {
    var el = $(sel); if (!el) return;
    var cur = el.value;
    el.innerHTML = '<option value="">All issues</option>' + opts;
    if (cur) el.value = cur;
  });
  var pb = $('#pbIssue');
  if (pb) { var c = pb.value; pb.innerHTML = opts; if (c) pb.value = c; }
}

/* ---------------- clock + countdowns ---------------- */
function tickClock() {
  var n = new Date();
  $('#clock').textContent = n.toLocaleTimeString('en-IN', { hour12: false }) + ' IST';
  $$('.cdn').forEach(function (el) {
    var ms = new Date(el.dataset.close) - n;
    el.textContent = ms > 0 ? 'closes in ' + hms(ms) : 'window closed';
  });
}

/* ---------------- bid book ---------------- */
async function loadBook() {
  var q = [];
  if ($('#bkIssue').value) q.push('issue_id=' + encodeURIComponent($('#bkIssue').value));
  if ($('#bkCat').value) q.push('category=' + encodeURIComponent($('#bkCat').value));
  if ($('#bkStatus').value) q.push('status=' + encodeURIComponent($('#bkStatus').value));
  if ($('#bkQ').value.trim()) q.push('q=' + encodeURIComponent($('#bkQ').value.trim()));
  if ($('#bkStatus').value === 'Cancelled') q.push('include_cancelled=1');
  try {
    var d = await api('/bids' + (q.length ? '?' + q.join('&') : ''));
    var b = d.bids || [];
    $('#bkCount').textContent = b.length + ' bid(s) · ' +
      inr(b.reduce(function (t, x) { return t + Number(x.qty || 0); }, 0), 0) + ' shares · ' +
      crore(b.reduce(function (t, x) { return t + Number(x.value || 0); }, 0));
    $('#bookTbl').innerHTML = b.length ? (
      '<thead><tr><th>Ref</th><th>Symbol</th><th>UCC</th><th>Client</th><th>PAN</th><th>Cat</th>' +
      '<th class="n">Qty</th><th class="n">Price</th><th class="n">Value</th><th>Status</th><th>By</th><th></th></tr></thead><tbody>' +
      b.map(function (x) {
        return '<tr data-bid="' + x.id + '">' +
          '<td class="m">' + esc(x.ref) + '</td><td>' + esc(x.symbol || '') + '</td>' +
          '<td class="m">' + esc(x.client_ucc) + '</td><td>' + esc(x.client_name || '') + '</td>' +
          '<td class="m">' + esc(x.pan || '') + '</td>' +
          '<td><span class="tag ' + (x.category === 'Retail' ? 'ret' : 'hni') + '">' + esc(x.category) + '</span></td>' +
          '<td class="n">' + inr(x.qty, 0) + '</td>' +
          '<td class="n">' + (x.is_cutoff ? 'Cut-off' : inr(x.price, 2)) + '</td>' +
          '<td class="n">' + inr(x.value, 0) + '</td>' +
          '<td><span class="st ' + statusCls(x.status) + '">' + esc(x.status) + '</span></td>' +
          '<td>' + esc(x.placed_by) + '</td>' +
          '<td>' + (x.status === 'Cancelled' ? '' : '<button class="mini" data-cancel="' + x.id + '">Cancel</button>') + '</td>' +
        '</tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="empty">No bid matches this filter.</td></tr></tbody>';
  } catch (e) { toast('Bid book failed', e.message, 'bad'); }
}

async function cancelBid(id) {
  if (!window.confirm('Cancel this bid? The row is kept for audit.')) return;
  try {
    await api('/bids/' + id, { method: 'DELETE', body: { reason: 'desk cancel' } });
    toast('Bid cancelled', 'The client may bid again for this scrip.', 'ok');
    loadBook(); loadDash();
  } catch (e) { toast('Cancel failed', (e.body && e.body.error) || e.message, 'bad'); }
}

/* ---------------- place bid ---------------- */
function bidPayload() {
  var cutoff = $('#pbType').value === 'cutoff';
  return {
    issue_id: $('#pbIssue').value,
    client_ucc: $('#pbUcc').value.trim().toUpperCase(),
    category: $('#pbCat').value,
    qty: Number($('#pbQty').value) || 0,
    is_cutoff: cutoff,
    price: cutoff ? null : Number($('#pbPrice').value) || 0
  };
}

async function validateBid() {
  var p = bidPayload();
  if (!p.issue_id || !p.client_ucc) { toast('Missing input', 'Pick an issue and enter a client UCC.', 'bad'); return; }
  try {
    var r = await api('/bids/validate', { method: 'POST', body: p });
    $('#pbPlace').disabled = !r.ok;
    $('#pbResult').innerHTML = r.ok
      ? '<div class="note" style="border-left-color:var(--ok)">Valid — bid value ' + rupee(r.value, 0) +
        ', free margin ' + rupee(r.free_margin, 0) + '. Minimum price ' + rupee(r.min_price) + '.</div>'
      : '<div class="note" style="border-left-color:var(--bad)">' +
        r.errors.map(function (x) { return '• ' + esc(x); }).join('<br>') + '</div>';
    loadClientPanel(p.client_ucc);
  } catch (e) { toast('Validation failed', (e.body && e.body.error) || e.message, 'bad'); }
}

async function loadClientPanel(ucc) {
  try {
    var d = await api('/clients/' + encodeURIComponent(ucc));
    var c = d.client;
    $('#pbClient').className = '';
    $('#pbClient').innerHTML =
      '<div class="grid2">' +
        '<div class="f"><div class="k">Name</div><div class="v">' + esc(c.name || '') + '</div></div>' +
        '<div class="f"><div class="k">PAN</div><div class="v">' + esc(c.pan || '') + '</div></div>' +
        '<div class="f"><div class="k">Mobile</div><div class="v">' + esc(c.mobile || '') + '</div></div>' +
        '<div class="f"><div class="k">Email</div><div class="v">' + esc(c.email || '') + '</div></div>' +
        '<div class="f"><div class="k">Available margin</div><div class="v">' + rupee(c.available_margin, 0) + '</div></div>' +
        '<div class="f"><div class="k">Free margin</div><div class="v">' + rupee(d.free_margin, 0) + '</div></div>' +
      '</div>' + (d.pii_unmasked ? '' : '<div class="note">PII is masked. An explicit unmask grant is required to see full values.</div>');
  } catch (e) {
    $('#pbClient').className = 'note';
    $('#pbClient').textContent = e.status === 404 ? 'No LD client found for that UCC.' : e.message;
  }
}

async function placeBid() {
  try {
    var r = await api('/bids', { method: 'POST', body: bidPayload() });
    toast('Bid placed', r.bid.ref + ' · ' + inr(r.bid.qty, 0) + ' shares · ' + rupee(r.bid.value, 0), 'ok');
    $('#pbPlace').disabled = true;
    $('#pbQty').value = ''; $('#pbPrice').value = '';
    loadDash();
  } catch (e) {
    var msg = e.body && e.body.errors ? e.body.errors.join(' ') : (e.body && e.body.error) || e.message;
    toast('Bid rejected', msg, 'bad');
  }
}

/* ---------------- export ---------------- */
function exportQuery() {
  return ['issue_id=' + encodeURIComponent($('#exIssue').value || 'all'),
          'category=' + encodeURIComponent($('#exCat').value),
          'include_cancelled=' + encodeURIComponent($('#exCanc').value)].join('&');
}

async function previewExport() {
  try {
    var d = await api('/export/' + $('#exExch').value + '/preview?' + exportQuery());
    $('#exSummary').innerHTML = '<div class="bar"><span class="tag">' + esc(d.file_name) + '</span>' +
      '<span class="tag">' + d.row_count + ' row(s)</span>' +
      '<span class="tag">' + inr(d.total_qty, 0) + ' shares</span>' +
      '<span class="tag">' + crore(d.total_value) + '</span>' +
      '<span class="tag">sha256 ' + esc(String(d.checksum).slice(0, 12)) + '…</span></div>';
    var lines = d.preview || [];
    if (!lines.length) { $('#exTbl').innerHTML = '<tbody><tr><td class="empty">No bid matches this selection.</td></tr></tbody>'; return; }
    var head = lines[0].split(',');
    $('#exTbl').innerHTML = '<thead><tr>' + head.map(function (h) { return '<th>' + esc(h.replace(/^"|"$/g, '')) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      lines.slice(1).map(function (l) {
        return '<tr>' + l.split(',').map(function (v) { return '<td class="m">' + esc(v.replace(/^"|"$/g, '')) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>';
  } catch (e) { toast('Preview failed', (e.body && e.body.error) || e.message, 'bad'); }
}

async function downloadExport() {
  var url = '/api/export/' + $('#exExch').value + '/download?' + exportQuery();
  var headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
  try {
    var res = await fetch(url, { headers: headers, credentials: 'same-origin' });
    if (!res.ok) { var j = await res.json().catch(function () { return {}; }); throw new Error(j.error || res.statusText); }
    var name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    var blob = await res.blob();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name ? name[1] : 'ofs_bids.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('File generated', 'Logged to ofs_export_log with checksum ' +
      String(res.headers.get('X-OFS-Checksum') || '').slice(0, 12) + '…', 'ok');
    loadExportLog();
  } catch (e) { toast('Download failed', e.message, 'bad'); }
}

async function loadExportLog() {
  try {
    var d = await api('/export/log');
    var r = d.exports || [];
    $('#exLogTbl').innerHTML = r.length ? (
      '<thead><tr><th>Generated</th><th>Exchange</th><th>Symbol</th><th>File</th>' +
      '<th class="n">Rows</th><th class="n">Qty</th><th>Checksum</th><th>By</th></tr></thead><tbody>' +
      r.map(function (x) {
        return '<tr><td class="m">' + dt(x.generated_at) + '</td><td>' + esc(x.exchange) + '</td>' +
          '<td>' + esc(x.symbol || 'ALL') + '</td><td class="m">' + esc(x.file_name) + '</td>' +
          '<td class="n">' + inr(x.row_count, 0) + '</td><td class="n">' + inr(x.total_qty, 0) + '</td>' +
          '<td class="m">' + esc(String(x.checksum).slice(0, 16)) + '…</td><td>' + esc(x.generated_by || '') + '</td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="empty">No file generated yet.</td></tr></tbody>';
  } catch (e) { /* route is page-gated; ignore */ }
}

/* ---------------- masters ---------------- */
function showMTab(t) {
  STATE.mtab = t;
  $('#mIssues').classList.toggle('hide', t !== 'issues');
  $('#mMargins').classList.toggle('hide', t !== 'margins');
  $('#mSettings').classList.toggle('hide', t !== 'settings');
  if (t === 'margins') loadMargins();
  if (t === 'settings') loadSettings();
  if (t === 'issues') loadIssues();
}
function loadMasters() { showMTab(STATE.mtab); }

async function loadIssues() {
  try {
    var d = await api('/issues');
    var r = d.issues || [];
    $('#issueTbl').innerHTML = r.length ? (
      '<thead><tr><th>Symbol</th><th>Company</th><th>ISIN</th><th>Exch</th>' +
      '<th class="n">Floor</th><th class="n">Cut-off min</th><th class="n">Tick</th><th class="n">Lot</th>' +
      '<th>HNI window</th><th>Retail window</th><th>Status</th></tr></thead><tbody>' +
      r.map(function (i) {
        return '<tr><td><b>' + esc(i.symbol) + '</b></td><td>' + esc(i.company) + '</td>' +
          '<td class="m">' + esc(i.isin) + '</td><td>' + esc(i.exchange) + '</td>' +
          '<td class="n">' + inr(i.floor_price) + '</td><td class="n">' + inr(i.cut_price_min) + '</td>' +
          '<td class="n">' + inr(i.tick) + '</td><td class="n">' + inr(i.lot, 0) + '</td>' +
          '<td class="m">' + dt(i.hni_open) + ' → ' + dt(i.hni_close) + '</td>' +
          '<td class="m">' + dt(i.ret_open) + ' → ' + dt(i.ret_close) + '</td>' +
          '<td><span class="chip ' + chipCls(i.status_label) + '">' + esc(i.status_label) + '</span></td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="empty">No issue in the master yet.</td></tr></tbody>';
  } catch (e) { toast('Issues failed', e.message, 'bad'); }
}

function fld(id, label, type, val) {
  return '<label class="f"><span class="k">' + esc(label) + '</span>' +
    '<input id="' + id + '" type="' + type + '" step="any" style="width:100%" value="' + (val || '') + '"></label>';
}
function fldSel(id, label, opts) {
  return '<label class="f"><span class="k">' + esc(label) + '</span><select id="' + id + '" style="width:100%">' +
    opts.map(function (o) { return '<option>' + o + '</option>'; }).join('') + '</select></label>';
}

function issueForm() {
  var f = $('#miForm');
  f.classList.remove('hide');
  f.innerHTML =
    '<div class="card"><div class="grid2">' +
      fld('fSymbol', 'Symbol', 'text') + fld('fCompany', 'Company', 'text') +
      fld('fIsin', 'ISIN', 'text') + fldSel('fExch', 'Exchange', ['NSE', 'BSE', 'BOTH']) +
      fld('fFloor', 'Floor price', 'number') + fld('fCut', 'Retail cut-off min', 'number') +
      fld('fTick', 'Tick', 'number', '0.05') + fld('fLot', 'Lot', 'number', '1') +
      fld('fIssueQty', 'Issue qty (for subscription)', 'number') + fld('fRetQty', 'Retail reserved qty', 'number') +
      fld('fHniOpen', 'HNI open', 'datetime-local') + fld('fHniClose', 'HNI close', 'datetime-local') +
      fld('fRetOpen', 'Retail open', 'datetime-local') + fld('fRetClose', 'Retail close', 'datetime-local') +
    '</div><div class="bar" style="margin-top:12px">' +
      '<button class="btn" id="miSave">Save issue</button>' +
      '<button class="btn ghost" id="miCancel">Cancel</button></div></div>';
  $('#miSave').addEventListener('click', saveIssue);
  $('#miCancel').addEventListener('click', function () { f.classList.add('hide'); });
}

async function saveIssue() {
  var body = {
    symbol: $('#fSymbol').value.trim().toUpperCase(),
    company: $('#fCompany').value.trim(),
    isin: $('#fIsin').value.trim().toUpperCase(),
    exchange: $('#fExch').value,
    floor_price: Number($('#fFloor').value),
    cut_price_min: $('#fCut').value ? Number($('#fCut').value) : null,
    tick: Number($('#fTick').value) || 0.05,
    lot: Number($('#fLot').value) || 1,
    issue_qty: $('#fIssueQty').value ? Number($('#fIssueQty').value) : null,
    retail_qty: $('#fRetQty').value ? Number($('#fRetQty').value) : null,
    hni_open: $('#fHniOpen').value, hni_close: $('#fHniClose').value,
    ret_open: $('#fRetOpen').value, ret_close: $('#fRetClose').value
  };
  try {
    await api('/issues', { method: 'POST', body: body });
    toast('Issue added', body.symbol + ' is now in the master.', 'ok');
    $('#miForm').classList.add('hide');
    loadIssues(); loadDash();
  } catch (e) { toast('Save failed', (e.body && e.body.field) || (e.body && e.body.error) || e.message, 'bad'); }
}

async function loadMargins() {
  try {
    var d = await api('/margin');
    var r = d.margins || [];
    $('#marginTbl').innerHTML = r.length ? (
      '<thead><tr><th>UCC</th><th class="n">Available</th><th class="n">Used</th><th class="n">Free</th>' +
      '<th>Source</th><th>Updated</th><th>By</th></tr></thead><tbody>' +
      r.map(function (m) {
        return '<tr><td class="m">' + esc(m.client_ucc) + '</td>' +
          '<td class="n">' + inr(m.available, 0) + '</td><td class="n">' + inr(m.used, 0) + '</td>' +
          '<td class="n">' + inr(m.free, 0) + '</td><td>' + esc(m.source) + '</td>' +
          '<td class="m">' + dt(m.updated_at) + '</td><td>' + esc(m.updated_by || '') + '</td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="empty">No margin snapshot loaded. RMS has no available-margin read API yet — set margins here or via CSV.</td></tr></tbody>';
  } catch (e) { toast('Margins failed', e.message, 'bad'); }
}

async function setMargin() {
  var ucc = $('#mgUcc').value.trim().toUpperCase(), amt = Number($('#mgAmt').value);
  if (!ucc || !isFinite(amt)) { toast('Missing input', 'Enter a UCC and an amount.', 'bad'); return; }
  try {
    await api('/margin/' + encodeURIComponent(ucc), { method: 'PUT', body: { available: amt, source: 'manual' } });
    toast('Margin set', ucc + ' → ' + rupee(amt, 0), 'ok');
    $('#mgAmt').value = ''; loadMargins();
  } catch (e) { toast('Failed', (e.body && e.body.error) || e.message, 'bad'); }
}

async function loadSettings() {
  try {
    var d = await api('/settings');
    var s = d.settings || {};
    $('#setTbl').innerHTML = '<thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>' +
      Object.keys(s).sort().map(function (k) {
        return '<tr><td class="m">' + esc(k) + '</td><td class="m">' + esc(s[k]) + '</td></tr>';
      }).join('') + '</tbody>';
  } catch (e) { /* route is page-gated; ignore */ }
}

/* ---------------- boot ---------------- */
function setAutoRefresh() {
  if (STATE.timer) clearInterval(STATE.timer);
  var ms = Number($('#autoRefresh').value) || 0;
  if (ms) STATE.timer = setInterval(function () {
    loadDash();
    if (STATE.tab === 'book') loadBook();
  }, ms);
}

async function boot() {
  try {
    var me = await api('/me');
    $('#whoName').textContent = me.user.email || ('user #' + me.user.id);
    $('#whoRole').textContent = me.user.role || '';
  } catch (e) {
    $('#whoName').textContent = 'Not signed in';
    $('#whoRole').textContent = 'ofs-desk grant required';
  }

  $$('#tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
  $$('[data-mtab]').forEach(function (b) { b.addEventListener('click', function () { showMTab(b.dataset.mtab); }); });
  $('#btnRefresh').addEventListener('click', function () { loadDash(); if (STATE.tab === 'book') loadBook(); });
  $('#autoRefresh').addEventListener('change', setAutoRefresh);
  $('#bkGo').addEventListener('click', loadBook);
  $('#bkQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadBook(); });
  ['#bkIssue', '#bkCat', '#bkStatus'].forEach(function (s) { $(s).addEventListener('change', loadBook); });
  $('#bookTbl').addEventListener('click', function (e) {
    var b = e.target.closest('[data-cancel]');
    if (b) cancelBid(b.dataset.cancel);
  });
  $('#pbCheck').addEventListener('click', validateBid);
  $('#pbPlace').addEventListener('click', placeBid);
  $('#pbType').addEventListener('change', function () {
    $('#pbPrice').disabled = $('#pbType').value === 'cutoff';
  });
  ['#exExch', '#exIssue', '#exCat', '#exCanc'].forEach(function (s) { $(s).addEventListener('change', previewExport); });
  $('#exPreview').addEventListener('click', previewExport);
  $('#exDownload').addEventListener('click', downloadExport);
  $('#miNew').addEventListener('click', issueForm);
  $('#mgSet').addEventListener('click', setMargin);

  await loadDash();
  setAutoRefresh();
  tickClock();
  setInterval(tickClock, 1000);
}

document.addEventListener('DOMContentLoaded', boot);
