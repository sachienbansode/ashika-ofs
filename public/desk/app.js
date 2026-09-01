'use strict';
/* OFS desk UI. CSP-safe: no inline script, no external CDN, no chart library. */

var $  = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

var TOKEN = null;                      // set by the host shell; falls back to the cookie session
var STATE = { dash: null, issues: [], book: [], editing: null, timer: null, tab: 'dash', mtab: 'issues' };

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
    if (e.status === 401) {
      // The session died under us - stop polling and say so, rather than
      // stacking an error toast every few seconds behind a stale dashboard.
      if (STATE.timer) clearInterval(STATE.timer);
      await checkSession();
    } else {
      toast('Dashboard failed', e.message, 'bad');
    }
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
  if (pb) {
    var c = STATE.editing ? String(STATE.editing.issue_id) : pb.value;
    pb.innerHTML = opts;
    if (c) pb.value = c;
  }
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
    STATE.book = b;
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
          '<td>' + (x.status === 'Cancelled' ? '' :
            '<button class="mini" data-edit="' + x.id + '">Modify</button> ' +
            '<button class="mini" data-cancel="' + x.id + '">Cancel</button>') + '</td>' +
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
  if (STATE.editing) {
    return {
      editingId: STATE.editing.id,
      issue_id: STATE.editing.issue_id,
      client_ucc: STATE.editing.client_ucc,
      category: $('#pbCat').value,
      qty: Number($('#pbQty').value) || 0,
      is_cutoff: cutoff,
      price: cutoff ? null : Number($('#pbPrice').value) || 0
    };
  }
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
  if (STATE.editing) p.editingId = STATE.editing.id;
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
  var editing = STATE.editing;
  try {
    var r = editing
      ? await api('/bids/' + editing.id, { method: 'PUT', body: bidPayload() })
      : await api('/bids', { method: 'POST', body: bidPayload() });
    toast(editing ? 'Bid modified' : 'Bid placed',
      r.bid.ref + ' · ' + inr(r.bid.qty, 0) + ' shares · ' + rupee(r.bid.value, 0), 'ok');
    $('#pbPlace').disabled = true;
    $('#pbQty').value = ''; $('#pbPrice').value = '';
    if (editing) { endModify(); showTab('book'); }
    loadDash();
  } catch (e) {
    var msg = e.body && e.body.errors ? e.body.errors.join(' ') : (e.body && e.body.error) || e.message;
    toast(editing ? 'Modify rejected' : 'Bid rejected', msg, 'bad');
  }
}

/* ---- modify an existing bid: the place-bid form doubles as the edit form ---- */
function startModify(id) {
  var bid = STATE.book.filter(function (x) { return String(x.id) === String(id); })[0];
  if (!bid) { toast('Not found', 'Reload the bid book and try again.', 'bad'); return; }
  STATE.editing = bid;
  $('#pbTitle').textContent = 'Modify bid';
  $('#pbEditBar').classList.remove('hide');
  $('#pbEditBar').innerHTML = 'Modifying <b>' + esc(bid.ref) + '</b> — ' + esc(bid.symbol || '') +
    ' · ' + esc(bid.client_ucc) + ' · placed ' + dt(bid.created_at) +
    ' <button class="mini" data-endedit="1" style="margin-left:8px">Cancel edit</button>';
  $('#pbUcc').value = bid.client_ucc;
  $('#pbUcc').disabled = true;
  $('#pbIssue').value = String(bid.issue_id);
  $('#pbIssue').disabled = true;
  $('#pbCat').value = bid.category;
  $('#pbQty').value = bid.qty;
  $('#pbType').value = bid.is_cutoff ? 'cutoff' : 'price';
  $('#pbPrice').value = bid.is_cutoff ? '' : bid.price;
  $('#pbPrice').disabled = !!bid.is_cutoff;
  $('#pbPlace').textContent = 'Update bid';
  $('#pbPlace').disabled = true;
  $('#pbResult').innerHTML = '';
  showTab('place');
  loadClientPanel(bid.client_ucc);
}

function endModify() {
  STATE.editing = null;
  $('#pbTitle').textContent = 'Bid on behalf of a client';
  $('#pbEditBar').classList.add('hide');
  $('#pbEditBar').innerHTML = '';
  $('#pbUcc').disabled = false;
  $('#pbIssue').disabled = false;
  $('#pbPlace').textContent = 'Place bid';
  $('#pbPlace').disabled = true;
  $('#pbResult').innerHTML = '';
  $('#pbQty').value = ''; $('#pbPrice').value = '';
}

/* ---------------- export ---------------- */
function exportQuery(part) {
  var q = ['issue_id=' + encodeURIComponent($('#exIssue').value || 'all'),
           'category=' + encodeURIComponent($('#exCat').value),
           'include_cancelled=' + encodeURIComponent($('#exCanc').value)];
  if (part) q.push('part=' + encodeURIComponent(part));
  return q.join('&');
}

async function previewExport() {
  try {
    var d = await api('/export/' + $('#exExch').value + '/preview?' + exportQuery());
    var parts = Number(d.parts) || 1;
    $('#exSummary').innerHTML = '<div class="bar"><span class="tag">' + esc(d.file_name) + '</span>' +
      '<span class="tag">' + d.row_count + ' row(s)</span>' +
      '<span class="tag">' + inr(d.total_qty, 0) + ' shares</span>' +
      '<span class="tag">' + crore(d.total_value) + '</span>' +
      '<span class="tag">sha256 ' + esc(String(d.checksum).slice(0, 12)) + '…</span>' +
      (d.has_header_row === false ? '<span class="tag">no header row</span>' : '') +
      '</div>' +
      (parts > 1
        ? '<div class="note">' + d.total_rows + ' bids exceed the ' + d.max_rows_per_file +
          '-record limit for one file, so this exports as <b>' + parts + ' files</b>. ' +
          'Download each part and upload all of them — the exchange takes only the first ' +
          d.max_rows_per_file + ' rows of a single file.' +
          '<div class="bar" style="margin:10px 0 0">' +
          Array.from({ length: parts }, function (_, i) {
            return '<button class="mini" data-part="' + (i + 1) + '">Download part ' +
              (i + 1) + ' of ' + parts + '</button>';
          }).join('') + '</div></div>'
        : '');
    var lines = d.preview || [];
    if (!lines.length) { $('#exTbl').innerHTML = '<tbody><tr><td class="empty">No bid matches this selection.</td></tr></tbody>'; return; }
    var head = lines[0].split(',');
    $('#exTbl').innerHTML = '<thead><tr>' + head.map(function (h) { return '<th>' + esc(h.replace(/^"|"$/g, '')) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      lines.slice(1).map(function (l) {
        return '<tr>' + l.split(',').map(function (v) { return '<td class="m">' + esc(v.replace(/^"|"$/g, '')) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>';
  } catch (e) { toast('Preview failed', (e.body && e.body.error) || e.message, 'bad'); }
}

async function downloadExport(part) {
  var url = '/api/export/' + $('#exExch').value + '/download?' + exportQuery(part);
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
  closeImport();
  $('#mIssues').classList.toggle('hide', t !== 'issues');
  $('#mMargins').classList.toggle('hide', t !== 'margins');
  $('#mArchive').classList.toggle('hide', t !== 'archive');
  $('#mSettings').classList.toggle('hide', t !== 'settings');
  if (t === 'margins') loadMargins();
  if (t === 'settings') loadSettings();
  if (t === 'issues') loadIssues();
  if (t === 'archive') loadArchive();
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

/**
 * Pull the issue master from the exchange. Preview first, always: the desk sees what
 * would land, and only then decides. The exchange owns the facts; a refresh never
 * reopens an issue the desk has suspended.
 */
async function syncIssues() {
  var ex = $('#miSyncEx').value;
  var btn = $('#miSync');
  btn.disabled = true; btn.textContent = 'Fetching ' + ex + '…';
  try {
    var p = await api('/issues/sync/preview?exchange=' + encodeURIComponent(ex));
    if (!p.found) {
      toast('Nothing found on ' + ex,
        p.reachable ? 'Reached the exchange but no issue rows were returned — there may be none open.'
                    : 'Could not reach the exchange from the server.', 'bad');
      console.warn('[sync] attempts:', p.attempts);
      return;
    }
    var lines = p.issues.slice(0, 10).map(function (i) {
      return i.symbol + ' — floor ' + inr(i.floor_price) + ', ' + dt(i.hni_open) + ' → ' + dt(i.ret_close);
    }).join('\n');
    if (!window.confirm('Import ' + p.found + ' issue(s) from ' + ex + '?\n\n' + lines +
        (p.found > 10 ? '\n…and ' + (p.found - 10) + ' more' : '') +
        (p.rejected.length ? '\n\n' + p.rejected.length + ' row(s) will be skipped as incomplete.' : ''))) return;

    var r = await api('/issues/sync', { method: 'POST', body: { exchange: ex } });
    toast('Issue master updated',
      r.inserted + ' new, ' + r.updated + ' updated, ' + r.unchanged + ' unchanged', 'ok');
    loadIssues(); loadDash();
  } catch (e) {
    toast('Sync failed', (e.body && e.body.message) || e.message, 'bad');
  } finally {
    btn.disabled = false; btn.textContent = 'Fetch from exchange';
  }
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

/**
 * Settings are editable here rather than only in the database: the cut-off, the
 * retail cap and the exchange category codes all change desk behaviour, and the
 * desk should not need a DBA to move them. Each is validated server-side against
 * what SEBI or the exchange actually permits, and each change is audited.
 */
async function loadSettings() {
  try {
    var d = await api('/settings');
    var rows = d.editable || [];
    $('#setTbl').innerHTML =
      '<thead><tr><th>Setting</th><th style="width:180px">Value</th><th></th><th>What it does</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var input;
        if (r.choices && r.choices.length > 1) {
          input = '<select data-set="' + esc(r.key) + '">' + r.choices.map(function (c) {
            return '<option' + (String(r.value) === c ? ' selected' : '') + '>' + esc(c) + '</option>';
          }).join('') + '</select>';
        } else if (r.kind === 'bool') {
          input = '<select data-set="' + esc(r.key) + '">' +
            '<option value="1"' + (String(r.value) === '1' ? ' selected' : '') + '>Yes</option>' +
            '<option value="0"' + (String(r.value) === '0' ? ' selected' : '') + '>No</option></select>';
        } else {
          input = '<input type="' + (r.kind === 'number' ? 'number' : 'text') + '" ' +
            'data-set="' + esc(r.key) + '" value="' + esc(r.value == null ? '' : r.value) + '"' +
            (r.kind === 'time' ? ' placeholder="15:15"' : '') + ' style="width:100%">';
        }
        return '<tr>' +
          '<td><b>' + esc(r.label) + '</b><br><span class="m" style="font-size:11px;color:var(--muted)">' +
            esc(r.key) + '</span></td>' +
          '<td>' + input + '</td>' +
          '<td><button class="mini" data-save="' + esc(r.key) + '">Save</button></td>' +
          '<td style="white-space:normal;font-size:11.5px;color:var(--muted);max-width:380px">' +
            esc(r.hint) + '</td>' +
        '</tr>';
      }).join('') + '</tbody>';
  } catch (e) {
    $('#setTbl').innerHTML = '<tbody><tr><td class="empty">' + esc(e.message) + '</td></tr></tbody>';
  }
}

async function saveSetting(key) {
  var el = $('[data-set="' + key + '"]');
  if (!el) return;
  try {
    var r = await api('/settings', { method: 'PUT', body: { key: key, value: el.value } });
    if (r.unchanged) { toast('No change', key + ' is already ' + el.value); return; }
    toast('Saved', key + ': ' + r.previous + ' → ' + r.value, 'ok');
    loadDash();                       // the cut-off shows on the dashboard
  } catch (e) {
    toast('Not saved', (e.body && e.body.message) || e.message, 'bad');
    loadSettings();                   // put the rejected value back
  }
}

/* ---------------- CSV import (issue masters + margins) ---------------- */
/* csvParse / csvObjects come from csv.js, loaded before this file. */

function pickCsv(cb) {
  var el = $('#filePick');
  el.value = '';
  el.onchange = function () {
    var f = el.files && el.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () { cb(csvObjects(csvParse(fr.result)), f.name); };
    fr.readAsText(f);
  };
  el.click();
}

function downloadText(name, text) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
}

function closeImport() { $('#importPane').classList.add('hide'); $('#importPane').innerHTML = ''; }

/** Shared preview + confirm shell. cols: [{key,label}]; onCommit(validRows). */
function importPreview(title, cols, parsed, note, onCommit) {
  var pane = $('#importPane');
  var valid = parsed.filter(function (r) { return !r.__error; });
  pane.classList.remove('hide');
  pane.innerHTML =
    '<div class="card"><div class="bar"><b>' + esc(title) + '</b>' +
      '<span class="tag">' + parsed.length + ' row(s) parsed</span>' +
      '<span class="tag">' + valid.length + ' valid</span>' +
      (parsed.length - valid.length ? '<span class="tag" style="color:var(--bad)">' +
        (parsed.length - valid.length) + ' rejected</span>' : '') +
      '<div class="sp"></div>' +
      '<button class="btn" id="impGo"' + (valid.length ? '' : ' disabled') + '>Import ' + valid.length + ' row(s)</button>' +
      '<button class="btn ghost" id="impClose">Close</button>' +
    '</div>' +
    (note ? '<div class="note">' + note + '</div>' : '') +
    '<div class="wrap"><table><thead><tr><th></th>' +
      cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') +
      '<th>Problem</th></tr></thead><tbody>' +
      parsed.slice(0, 200).map(function (r, ix) {
        return '<tr><td class="n">' + (ix + 1) + '</td>' +
          cols.map(function (c) { return '<td class="m">' + esc(r[c.key] == null ? '' : r[c.key]) + '</td>'; }).join('') +
          '<td style="color:var(--bad)">' + esc(r.__error || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      (parsed.length > 200 ? '<div class="legend">Showing the first 200 rows; all valid rows are imported.</div>' : '') +
    '</div>';
  $('#impClose').addEventListener('click', closeImport);
  $('#impGo').addEventListener('click', function () { onCommit(valid); });
}

var ISSUE_TEMPLATE =
  'symbol,company,isin,exchange,floor_price,cut_price_min,tick,lot,issue_qty,retail_qty,discount_pct,' +
  'hni_open,hni_close,ret_open,ret_close\r\n' +
  'COALINDIA,Coal India Ltd,INE522F01014,BOTH,385,385,0.05,1,50000000,5000000,5,' +
  '2026-09-02T09:15,2026-09-02T15:15,2026-09-03T09:15,2026-09-03T15:15\r\n';

function importIssues() {
  pickCsv(function (rows, fileName) {
    var need = ['symbol', 'company', 'isin', 'floor_price', 'hni_open', 'hni_close', 'ret_open', 'ret_close'];
    var parsed = rows.map(function (r) {
      var missing = need.filter(function (k) { return !r[k]; });
      var o = {
        symbol: String(r.symbol || '').toUpperCase(),
        company: r.company || '',
        isin: String(r.isin || '').toUpperCase(),
        exchange: ['NSE', 'BSE', 'BOTH'].indexOf(String(r.exchange || '').toUpperCase()) >= 0
          ? String(r.exchange).toUpperCase() : 'NSE',
        floor_price: Number(r.floor_price),
        cut_price_min: r.cut_price_min ? Number(r.cut_price_min) : null,
        tick: r.tick ? Number(r.tick) : 0.05,
        lot: r.lot ? Number(r.lot) : 1,
        issue_qty: r.issue_qty ? Number(r.issue_qty) : null,
        retail_qty: r.retail_qty ? Number(r.retail_qty) : null,
        discount_pct: r.discount_pct ? Number(r.discount_pct) : 0,
        hni_open: r.hni_open, hni_close: r.hni_close, ret_open: r.ret_open, ret_close: r.ret_close
      };
      if (missing.length) o.__error = 'missing ' + missing.join(', ');
      else if (!isFinite(o.floor_price) || o.floor_price <= 0) o.__error = 'floor_price must be a positive number';
      else if (new Date(o.hni_close) <= new Date(o.hni_open)) o.__error = 'hni_close must be after hni_open';
      else if (new Date(o.ret_close) <= new Date(o.ret_open)) o.__error = 'ret_close must be after ret_open';
      return o;
    });
    importPreview('Issue master — ' + fileName,
      [{ key: 'symbol', label: 'Symbol' }, { key: 'company', label: 'Company' }, { key: 'isin', label: 'ISIN' },
       { key: 'exchange', label: 'Exch' }, { key: 'floor_price', label: 'Floor' },
       { key: 'hni_open', label: 'HNI open' }, { key: 'hni_close', label: 'HNI close' },
       { key: 'ret_open', label: 'Retail open' }, { key: 'ret_close', label: 'Retail close' }],
      parsed,
      'Windows are read in the browser’s timezone (IST on the desk). Rows are posted one by one — a duplicate symbol/ISIN for the same day is rejected by the database.',
      async function (valid) {
        var ok = 0, failed = [];
        for (var i = 0; i < valid.length; i++) {
          var row = Object.assign({}, valid[i]); delete row.__error;
          try { await api('/issues', { method: 'POST', body: row }); ok++; }
          catch (e) { failed.push(row.symbol + ': ' + ((e.body && (e.body.field || e.body.error)) || e.message)); }
        }
        closeImport();
        toast('Issues imported', ok + ' added' + (failed.length ? ', ' + failed.length + ' failed' : ''),
          failed.length ? 'bad' : 'ok');
        if (failed.length) console.warn('[import] failures:', failed);
        loadIssues(); loadDash();
      });
  });
}

var MARGIN_TEMPLATE = 'ucc,available,note\r\nASH1001,250000,opening snapshot\r\n';

function importMargins() {
  pickCsv(function (rows, fileName) {
    var parsed = rows.map(function (r) {
      var o = {
        ucc: String(r.ucc || r.client_ucc || r.client_code || '').trim().toUpperCase(),
        available: Number(r.available || r.margin || r.available_margin),
        note: r.note || ''
      };
      if (!o.ucc) o.__error = 'missing ucc';
      else if (!isFinite(o.available) || o.available < 0) o.__error = 'available must be a number >= 0';
      return o;
    });
    importPreview('Margin snapshot — ' + fileName,
      [{ key: 'ucc', label: 'UCC' }, { key: 'available', label: 'Available' }, { key: 'note', label: 'Note' }],
      parsed,
      'This replaces each client’s available margin and writes an entry to ofs_margin_log. RMS has no available-margin read API yet, so this snapshot is the gate for every bid.',
      async function (valid) {
        try {
          var r = await api('/margin/bulk', {
            method: 'POST',
            body: { source: 'csv', rows: valid.map(function (x) { return { ucc: x.ucc, available: x.available }; }) }
          });
          closeImport();
          toast('Margins imported', r.updated + ' client(s) updated.', 'ok');
          loadMargins();
        } catch (e) { toast('Import failed', (e.body && e.body.error) || e.message, 'bad'); }
      });
  });
}

/* ---------------- archive ---------------- */
function archiveRow(i) {
  return '<tr data-arch="' + i.id + '">' +
    '<td><b>' + esc(i.symbol) + '</b><br><span style="font-size:11px;color:var(--muted)">' +
      esc(i.company || '') + '</span></td>' +
    '<td class="m">' + esc(i.isin || '') + '</td>' +
    '<td>' + esc(i.exchange) + '</td>' +
    '<td class="m">' + (i.issue_date ? String(i.issue_date).slice(0, 10) : '—') + '</td>' +
    '<td class="n">' + inr(i.floor_price) + '</td>' +
    '<td class="n">' + inr(i.bid_count, 0) + '</td>' +
    '<td class="n">' + inr(i.client_count, 0) + '</td>' +
    '<td class="n">' + inr(i.total_qty, 0) + '</td>' +
    '<td class="n">' + crore(i.total_value) + '</td>' +
    '<td class="n">' + inr(i.allot_qty, 0) + '</td>' +
    '<td class="n">' + inr(i.files_generated, 0) + '</td>' +
    '<td class="m">' + (i.archived_at ? dt(i.archived_at) : '—') + '</td>' +
    '<td><button class="mini" data-detail="' + i.id + '">Open</button> ' +
        '<button class="mini" data-unarch="' + i.id + '">Restore</button></td></tr>';
}

async function loadArchive() {
  try {
    var cands = await api('/issues/archive/candidates');
    $('#arCandidates').textContent = cands.candidates.length
      ? cands.candidates.length + ' closed over ' + cands.after_days + ' days ago'
      : 'nothing due for archiving';
    $('#arRun').disabled = !cands.candidates.length;

    var q = $('#arQ').value.trim();
    var d = await api('/issues/archive' + (q ? '?q=' + encodeURIComponent(q) : ''));
    var a = d.archived || [];
    $('#archiveTbl').innerHTML = a.length ? (
      '<thead><tr><th>Scrip</th><th>ISIN</th><th>Exch</th><th>Trading day</th>' +
      '<th class="n">Floor</th><th class="n">Bids</th><th class="n">Clients</th>' +
      '<th class="n">Qty</th><th class="n">Value</th><th class="n">Allotted</th>' +
      '<th class="n">Files</th><th>Archived</th><th></th></tr></thead><tbody>' +
      a.map(archiveRow).join('') + '</tbody>'
    ) : '<tbody><tr><td class="empty">Nothing archived yet.</td></tr></tbody>';
  } catch (e) { toast('Archive failed', e.message, 'bad'); }
}

/** The permanent record for one issue: every bid, file, allotment and action. */
async function openArchived(id) {
  try {
    var d = await api('/issues/' + id + '/summary');
    var i = d.issue;
    var money = function (k, v) {
      return '<div class="f"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
    };
    $('#arDetail').innerHTML =
      '<div class="card" style="margin-top:14px">' +
        '<div class="bar"><b style="font-size:15px">' + esc(i.symbol) + '</b>' +
          '<span style="color:var(--muted)">' + esc(i.company || '') + '</span>' +
          '<span class="tag">' + esc(i.exchange) + '</span>' +
          (i.archived_at ? '<span class="chip closed">Archived ' + dt(i.archived_at) +
            (i.archived_by ? ' by ' + esc(i.archived_by) : '') + '</span>' : '') +
          '<div class="sp"></div><button class="mini" id="arClose">Close</button></div>' +
        (i.archive_reason ? '<div class="note">' + esc(i.archive_reason) + '</div>' : '') +
        '<div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">' +
          money('Floor', rupee(i.floor_price)) +
          money('Bids', inr(i.bid_count, 0) + ' (' + inr(i.cancelled_bids, 0) + ' cancelled)') +
          money('Clients', inr(i.client_count, 0)) +
          money('Quantity', inr(i.total_qty, 0)) +
          money('Value', crore(i.total_value)) +
          money('Retail / HNI', crore(i.retail_value_bid) + ' / ' + crore(i.hni_value_bid)) +
          money('Book VWAP', i.vwap == null ? '—' : rupee(i.vwap)) +
          money('Allotted', inr(i.allot_qty, 0) + ' to ' + inr(i.allottees, 0)) +
          money('Allotment value', crore(i.allot_value)) +
          money('Emails sent', inr(i.allot_mails_sent, 0)) +
        '</div>' +

        '<h2 class="sec">Files generated (' + d.exports.length + ')</h2>' +
        '<div class="wrap"><table>' + (d.exports.length
          ? '<thead><tr><th>When</th><th>Exchange</th><th>File</th><th class="n">Rows</th>' +
            '<th>Checksum</th><th>By</th></tr></thead><tbody>' +
            d.exports.map(function (x) {
              return '<tr><td class="m">' + dt(x.generated_at) + '</td><td>' + esc(x.exchange) + '</td>' +
                '<td class="m">' + esc(x.file_name) + '</td><td class="n">' + inr(x.row_count, 0) + '</td>' +
                '<td class="m">' + esc(String(x.checksum).slice(0, 16)) + '…</td>' +
                '<td>' + esc(x.generated_by || '') + '</td></tr>';
            }).join('') + '</tbody>'
          : '<tbody><tr><td class="empty">No exchange file was generated.</td></tr></tbody>') + '</table></div>' +

        '<h2 class="sec">Bids (' + d.bids.length + ')</h2>' +
        '<div class="wrap"><table>' + (d.bids.length
          ? '<thead><tr><th>Ref</th><th>UCC</th><th>Cat</th><th class="n">Qty</th>' +
            '<th class="n">Price</th><th class="n">Value</th><th>Status</th><th>Placed</th></tr></thead><tbody>' +
            d.bids.map(function (b) {
              return '<tr><td class="m">' + esc(b.ref) + '</td><td class="m">' + esc(b.client_ucc) + '</td>' +
                '<td><span class="tag ' + (b.category === 'Retail' ? 'ret' : 'hni') + '">' +
                  esc(b.category) + '</span></td>' +
                '<td class="n">' + inr(b.qty, 0) + '</td>' +
                '<td class="n">' + (b.is_cutoff ? 'Cut-off' : inr(b.price, 2)) + '</td>' +
                '<td class="n">' + inr(b.value, 0) + '</td>' +
                '<td><span class="st ' + statusCls(b.status) + '">' + esc(b.status) + '</span></td>' +
                '<td class="m">' + dt(b.created_at) + '</td></tr>';
            }).join('') + '</tbody>'
          : '<tbody><tr><td class="empty">No bids were placed.</td></tr></tbody>') + '</table></div>' +

        (d.allotments.length
          ? '<h2 class="sec">Allotments (' + d.allotments.length + ')</h2><div class="wrap"><table>' +
            '<thead><tr><th>UCC</th><th class="n">Qty</th><th class="n">Price</th>' +
            '<th class="n">Value</th><th>Email</th></tr></thead><tbody>' +
            d.allotments.map(function (x) {
              return '<tr><td class="m">' + esc(x.client_ucc) + '</td>' +
                '<td class="n">' + inr(x.allot_qty, 0) + '</td>' +
                '<td class="n">' + (x.allot_price == null ? '—' : inr(x.allot_price, 2)) + '</td>' +
                '<td class="n">' + inr(x.allot_value, 0) + '</td>' +
                '<td>' + esc(x.mail_status) + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '') +
        (d.pii_unmasked ? '' : '<div class="note">Client PII is masked, as everywhere else.</div>') +
      '</div>';
    $('#arClose').addEventListener('click', function () { $('#arDetail').innerHTML = ''; });
    $('#arDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast('Could not open', e.message, 'bad'); }
}

async function runArchive() {
  try {
    var c = await api('/issues/archive/candidates');
    if (!c.candidates.length) { toast('Nothing to archive', 'No issue has been closed long enough.'); return; }
    var names = c.candidates.slice(0, 12).map(function (x) { return x.symbol; }).join(', ');
    if (!window.confirm('Archive ' + c.candidates.length + ' issue(s) closed more than ' +
        c.after_days + ' days ago?\n\n' + names +
        '\n\nNothing is deleted — bids, files and allotments stay attached, and any of these can be restored.')) return;
    var r = await api('/issues/archive/run', { method: 'POST', body: {} });
    toast('Archived', r.archived + ' issue(s) moved to the archive.', 'ok');
    loadArchive(); loadIssues(); loadDash();
  } catch (e) { toast('Archive failed', (e.body && e.body.message) || e.message, 'bad'); }
}

async function unarchive(id) {
  try {
    await api('/issues/' + id + '/unarchive', { method: 'POST', body: {} });
    toast('Restored', 'The issue is back on the desk.', 'ok');
    loadArchive(); loadIssues(); loadDash();
  } catch (e) { toast('Restore failed', e.message, 'bad'); }
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

/* ---------------- session ---------------- */
function showGate(title, message, why) {
  var portal = (window.OFS_PORTAL_URL || '').trim();
  $('#gate').classList.remove('hide');
  $('#gate').innerHTML = '<div class="box">' +
    '<h1>' + esc(title) + '</h1>' +
    '<p>' + esc(message) + '</p>' +
    (portal ? '<a class="btn" href="' + esc(portal) + '">Open the portal</a>' : '') +
    (why ? '<div class="why">' + esc(why) + '</div>' : '') +
    '</div>';
}

/**
 * Two doors lead here: the portal mints a one-time ticket (/auth/sso), or the user
 * signs in directly at /desk/login.html against the same platform account. Either
 * way this page only ever sees the resulting session cookie.
 */
async function checkSession() {
  try {
    var me = await api('/me');
    $('#whoName').textContent = me.user.email || ('user #' + me.user.id);
    $('#whoRole').textContent = me.user.role || '';
    $('#btnSignOut').classList.remove('hide');

    var pages = (me.permissions && me.permissions.pages) || [];
    var DESK = ['ofs-desk', 'ofs-masters'];
    var granted = pages.indexOf('*') >= 0 || pages.some(function (p) {
      return DESK.indexOf(String(p).split(':')[0]) >= 0;
    });
    if (!granted) {
      showGate('No access to the OFS desk',
        'Your account is signed in, but the ' + (me.user.role || 'assigned') +
        ' role does not include the OFS desk.',
        'An administrator grants the "ofs-desk" page to your role in the Admin console.');
      return false;
    }
    return true;
  } catch (e) {
    if (e.status === 401) {
      // No session: go straight to the sign-in page rather than showing a wall
      // that only tells the user where the door is.
      var stale = e.body && e.body.error === 'session_superseded';
      location.replace('/desk/login.html' + (stale ? '?reason=superseded' : ''));
      return false;
    }
    showGate('Cannot reach the server', e.message, 'Check that the app is running and try again.');
    return false;
  }
}

async function signOut() {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  location.reload();
}

async function boot() {
  var ready = await checkSession();

  $$('#tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
  $$('[data-mtab]').forEach(function (b) { b.addEventListener('click', function () { showMTab(b.dataset.mtab); }); });
  $('#btnRefresh').addEventListener('click', function () { loadDash(); if (STATE.tab === 'book') loadBook(); });
  $('#autoRefresh').addEventListener('change', setAutoRefresh);
  $('#bkGo').addEventListener('click', loadBook);
  $('#bkQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadBook(); });
  ['#bkIssue', '#bkCat', '#bkStatus'].forEach(function (s) { $(s).addEventListener('change', loadBook); });
  $('#bookTbl').addEventListener('click', function (e) {
    var c = e.target.closest('[data-cancel]');
    if (c) { cancelBid(c.dataset.cancel); return; }
    var m = e.target.closest('[data-edit]');
    if (m) startModify(m.dataset.edit);
  });
  $('#pbEditBar').addEventListener('click', function (e) {
    if (e.target.closest('[data-endedit]')) endModify();
  });
  $('#pbCheck').addEventListener('click', validateBid);
  $('#pbPlace').addEventListener('click', placeBid);
  $('#pbType').addEventListener('change', function () {
    $('#pbPrice').disabled = $('#pbType').value === 'cutoff';
  });
  ['#exExch', '#exIssue', '#exCat', '#exCanc'].forEach(function (s) { $(s).addEventListener('change', previewExport); });
  $('#exPreview').addEventListener('click', previewExport);
  $('#exDownload').addEventListener('click', function () { downloadExport(); });
  $('#exSummary').addEventListener('click', function (e) {
    var b = e.target.closest('[data-part]');
    if (b) downloadExport(b.dataset.part);
  });
  $('#miNew').addEventListener('click', issueForm);
  $('#miSync').addEventListener('click', syncIssues);
  $('#arGo').addEventListener('click', loadArchive);
  $('#arQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadArchive(); });
  $('#arRun').addEventListener('click', runArchive);
  $('#archiveTbl').addEventListener('click', function (e) {
    var d = e.target.closest('[data-detail]');
    if (d) { openArchived(d.dataset.detail); return; }
    var u = e.target.closest('[data-unarch]');
    if (u) unarchive(u.dataset.unarch);
  });
  $('#miImport').addEventListener('click', importIssues);
  $('#miTemplate').addEventListener('click', function () { downloadText('ofs_issue_template.csv', ISSUE_TEMPLATE); });
  $('#mgSet').addEventListener('click', setMargin);
  $('#mgImport').addEventListener('click', importMargins);
  $('#mgTemplate').addEventListener('click', function () { downloadText('ofs_margin_template.csv', MARGIN_TEMPLATE); });
  $('#setTbl').addEventListener('click', function (e) {
    var b = e.target.closest('[data-save]');
    if (b) saveSetting(b.dataset.save);
  });
  $('#setTbl').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.set) saveSetting(e.target.dataset.set);
  });

  $('#btnSignOut').addEventListener('click', signOut);

  tickClock();
  setInterval(tickClock, 1000);

  // Nothing below is worth doing without a usable session - every call would 401.
  if (!ready) return;

  await loadDash();
  setAutoRefresh();
}

document.addEventListener('DOMContentLoaded', boot);
