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
  var none = !STATE.issues || !STATE.issues.length;
  var pb0 = $('#pbNoIssues');
  if (pb0) pb0.classList.toggle('hide', !none);

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
// The desk trades on IST and the browser may not be on it — ask for the zone by
// name rather than labelling whatever the machine's clock says as IST.
var IST_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

function tickClock() {
  var n = new Date();
  $('#clock').textContent = IST_CLOCK.format(n) + ' IST';
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

/**
 * Say what is actually wrong. "Pick an issue" is unhelpful when the reason no issue
 * can be picked is that the master is empty — that needs a different instruction.
 */
function missingInputs(p) {
  var out = [];
  if (!p.issue_id) {
    out.push(STATE.issues && STATE.issues.length
      ? 'Choose an issue from the list.'
      : 'There is no open OFS in the master yet. Load one under Masters → Exchange pull, or Masters → Import issues CSV.');
  }
  if (!p.client_ucc) out.push('Enter the client UCC.');
  if (!p.qty) out.push('Enter a quantity.');
  if (!p.is_cutoff && !p.price) out.push('Enter a bid price, or switch the price type to cut-off.');
  return out;
}

function showBidErrors(list, heading) {
  $('#pbPlace').disabled = true;
  $('#pbResult').innerHTML = '<div class="note bad"><b>' + esc(heading || 'Cannot place this bid') + '</b><br>' +
    list.map(function (x) { return '• ' + esc(x); }).join('<br>') + '</div>';
}

async function validateBid() {
  var p = bidPayload();
  if (STATE.editing) p.editingId = STATE.editing.id;

  var missing = missingInputs(p);
  if (missing.length) {
    showBidErrors(missing, 'Fill these in first');
    toast('Missing input', missing[0], 'bad');
    return;
  }

  var btn = $('#pbCheck');
  btn.disabled = true;
  try {
    var r = await api('/bids/validate', { method: 'POST', body: p });
    $('#pbPlace').disabled = !r.ok;
    $('#pbResult').innerHTML = r.ok
      ? '<div class="note good"><b>Valid</b><br>Bid value ' + rupee(r.value, 0) +
        ' · free margin ' + rupee(r.free_margin, 0) + ' · minimum price ' + rupee(r.min_price) + '.</div>'
      : '<div class="note bad"><b>Cannot place this bid</b><br>' +
        (r.errors || ['Rejected.']).map(function (x) { return '• ' + esc(x); }).join('<br>') + '</div>';
    if (!r.ok) toast('Bid rejected', (r.errors && r.errors[0]) || 'See the reasons on the form.', 'bad');
    loadClientPanel(p.client_ucc);
  } catch (e) {
    // A 4xx from the server carries the reasons too — show them on the form rather
    // than dropping a bare status into a toast.
    var body = e.body || {};
    var list = body.errors || (body.message ? [body.message] : null) ||
               [e.message || 'The server could not validate this bid.'];
    showBidErrors(list, e.status === 401 ? 'Session expired' : 'Validation failed');
    toast('Validation failed', list[0], 'bad');
  } finally {
    btn.disabled = false;
  }
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
  $('#mSync').classList.toggle('hide', t !== 'sync');
  $('#mCirculars').classList.toggle('hide', t !== 'circulars');
  $('#mAudit').classList.toggle('hide', t !== 'audit');
  $('#mSettings').classList.toggle('hide', t !== 'settings');
  if (t === 'margins') loadMargins();
  if (t === 'settings') loadSettings();
  if (t === 'issues') loadIssues();
  if (t === 'archive') loadArchive();
  if (t === 'sync') loadSync(); else stopSyncPoll();
  if (t === 'audit') loadAudit(0);
  if (t === 'circulars') loadCirculars();
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
    var r = await api('/issues', { method: 'POST', body: body });
    var id = r && r.issue && r.issue.id;

    // If this issue came from a circular, attach that circular to it now. The link
    // is what justifies the floor price and the windows to anyone reading later.
    var c = STATE.fromCircular;
    if (id && c && c.link) {
      try {
        await api('/issues/' + id + '/docs', { method: 'POST',
          body: { url: c.link, title: c.title || 'NSE circular', kind: 'circular', source: 'NSE',
                  circular_id: c.id } });
        await api('/circulars/' + c.id, { method: 'PUT', body: { status: 'imported', issue_id: id } });
      } catch (e2) {
        toast('Issue saved, circular not attached', e2.message, 'warn');
      }
      STATE.fromCircular = null;
    }

    toast('Issue added', body.symbol + ' is now in the master.', 'ok');
    $('#miForm').classList.add('hide');
    loadIssues(); loadDash();
  } catch (e) { toast('Save failed', (e.body && e.body.field) || (e.body && e.body.error) || e.message, 'bad'); }
}

/* ================================================================= exchange pull
 * A pull is a row on the server, not a request the browser waits on: start it, then
 * poll for progress. That is what makes "why did this find nothing?" answerable —
 * every endpoint tried, and what it said, is shown as it happens.
 */
var SYNC = { timer: null, runId: null };

function stopSyncPoll() { if (SYNC.timer) { clearInterval(SYNC.timer); SYNC.timer = null; } }

function outClass(o) {
  if (o === 'ok') return 'ok';
  if (o === 'started' || o === 'info') return 'info';
  if (o === 'disabled' || o === 'no_data') return 'warn';
  return 'bad';
}

function renderSteps(steps) {
  $('#syLog').innerHTML = (steps || []).slice(-40).map(function (st) {
    return '<div><span class="ex">' + esc(st.exchange || '—') + '</span>' +
      '<span class="ms">' + esc(st.message || st.phase || '') + '</span>' +
      '<span class="out ' + outClass(st.outcome) + '">' + esc(st.outcome || '') + '</span></div>';
  }).join('');
  var log = $('#syLog'); log.scrollTop = log.scrollHeight;
}

var OUTCOME_WHY = {
  disabled: 'Web fetching is switched off (EXCHANGE_WEB_FETCH=false). Both exchanges ' +
            'prohibit automated collection without written consent, so the sanctioned ' +
            'route is Masters → Import issues CSV, fed from the T-2/T-1 member notice.',
  unreachable: 'Nothing answered. The server may have no route out, or the endpoint moved.',
  no_data: 'The exchange answered, but with nothing that parses as an OFS issue — ' +
           'usually because no OFS is open, or because the page is a JavaScript shell ' +
           'rather than data.',
  error: 'The pull failed before it could read anything.'
};

function renderSummary(run) {
  var ex = (run.summary && run.summary.exchanges) || [];
  if (!ex.length && run.status === 'running') { $('#sySummary').innerHTML = ''; return; }
  $('#sySummary').innerHTML = '<div class="sync-cards">' + ex.map(function (e) {
    var good = e.outcome === 'ok';
    return '<div class="sync-card"><h3>' + esc(e.exchange) +
      '<span class="chip ' + (good ? 'open' : e.outcome === 'disabled' ? 'grey' : 'closed') + '">' +
      esc(e.outcome) + '</span></h3>' +
      '<div class="figs">' +
      '<div class="fig"><b>' + (e.found || 0) + '</b><span>found</span></div>' +
      '<div class="fig"><b>' + (e.inserted || 0) + '</b><span>new</span></div>' +
      '<div class="fig"><b>' + (e.updated || 0) + '</b><span>updated</span></div>' +
      '<div class="fig"><b>' + (e.unchanged || 0) + '</b><span>unchanged</span></div>' +
      (e.rejected ? '<div class="fig"><b>' + e.rejected + '</b><span>skipped</span></div>' : '') +
      '</div>' +
      (good ? '' : '<div class="why">' + esc(OUTCOME_WHY[e.outcome] || '') + '</div>') +
      '</div>';
  }).join('') + '</div>';
}

function paintRun(run) {
  $('#syProgress').classList.remove('hide');
  var pct = Math.max(0, Math.min(100, run.progress || 0));
  $('#syProgFill').style.width = pct + '%';
  $('#syProgPct').textContent = pct + '%';
  $('#syProgTitle').textContent = run.status === 'running'
    ? 'Pulling from ' + (run.exchanges || []).join(' and ') + '…'
    : 'Pull #' + run.id + ' — ' + run.status +
      (run.status === 'ok' || run.status === 'partial'
        ? ' (' + run.inserted + ' new, ' + run.updated + ' updated)' : '');
  renderSteps(run.steps);
  renderSummary(run);
}

async function pollRun() {
  if (!SYNC.runId) return stopSyncPoll();
  try {
    var d = await api('/issues/sync/runs/' + SYNC.runId);
    paintRun(d.run);
    if (d.run.status !== 'running') {
      stopSyncPoll();
      SYNC.runId = null;
      $('#syRun').disabled = false;
      $('#syRun').textContent = 'Pull now';
      $('#miSync').disabled = false;
      loadSyncRuns(); loadSyncStatus(); loadIssues(); loadDash();
      toast(d.run.status === 'failed' ? 'Pull found nothing' : 'Pull finished',
        d.run.status === 'failed'
          ? (d.run.error || 'No exchange returned usable issue data.')
          : d.run.inserted + ' new, ' + d.run.updated + ' updated, ' + d.run.unchanged + ' unchanged',
        d.run.status === 'failed' ? 'bad' : 'ok');
    }
  } catch (e) { stopSyncPoll(); }
}

function watchRun(id) {
  SYNC.runId = id;
  stopSyncPoll();
  SYNC.timer = setInterval(pollRun, 1200);
  pollRun();
}

async function startSync(exchanges) {
  var list = exchanges || [$('#syNSE').checked ? 'NSE' : null, $('#syBSE').checked ? 'BSE' : null]
    .filter(Boolean);
  if (!list.length) return toast('Pick an exchange', 'Select NSE, BSE or both.', 'bad');

  $('#syRun').disabled = true; $('#syRun').textContent = 'Pulling…';
  $('#miSync').disabled = true;
  try {
    var d = await api('/issues/sync/run', { method: 'POST', body: { exchanges: list } });
    if (d.busy) toast('Already running', 'A pull started at ' + dt(d.run.started_at) + ' is still going.', 'warn');
    watchRun(d.run_id);
  } catch (e) {
    $('#syRun').disabled = false; $('#syRun').textContent = 'Pull now';
    $('#miSync').disabled = false;
    toast('Could not start the pull', (e.body && e.body.message) || e.message, 'bad');
  }
}

/** The Issues tab button: switch to this pane and start, so progress is visible. */
function syncIssues() { showMTab('sync'); startSync(); }

async function loadSyncStatus() {
  try {
    var st = await api('/issues/sync/status');
    var m = st.market || {};
    $('#syMarket').textContent = m.open
      ? 'Market open · bidding until ' + m.effective_close + ' IST'
      : 'Market closed (' + (m.reason || '').replace(/_/g, ' ') + ') · opens ' + m.opens + ' IST';

    $('#scEnabled').value = st.enabled ? '1' : '0';
    $('#scEvery').value = String(st.every_minutes);
    if (!$('#scEvery').value) $('#scEvery').value = '60';
    $('#scEx').value = (st.exchanges || []).join(',') || 'NSE,BSE';
    $('#scMarketOnly').value = st.market_only ? '1' : '0';

    $('#scNext').textContent = !st.enabled
      ? 'Auto-pull is off. Pulls happen only when someone presses Pull now.'
      : st.holding_for_market
        ? 'Due now, held until the market opens at ' + m.opens + ' IST.'
        : 'Next scheduled pull ' + (st.next_run_at ? dt(st.next_run_at) : 'shortly') +
          ' · every ' + st.every_minutes + ' minutes from ' + (st.exchanges || []).join(' and ') + '.';

    if (st.running && !SYNC.runId) watchRun(st.running.id);
  } catch (e) { /* the panel is informational; a failure here is not worth a toast */ }
}

async function saveSchedule() {
  var vals = [
    ['sync_enabled', $('#scEnabled').value],
    ['sync_every_minutes', $('#scEvery').value],
    ['sync_exchanges', $('#scEx').value],
    ['sync_market_only', $('#scMarketOnly').value]
  ];
  try {
    for (var i = 0; i < vals.length; i++) {
      await api('/settings', { method: 'PUT', body: { key: vals[i][0], value: vals[i][1] } });
    }
    toast('Schedule saved', $('#scEnabled').value === '1'
      ? 'Pulling every ' + $('#scEvery').value + ' minutes.' : 'Auto-pull is off.', 'ok');
    loadSyncStatus();
  } catch (e) { toast('Could not save', (e.body && e.body.message) || e.message, 'bad'); }
}

async function loadSyncRuns() {
  try {
    var d = await api('/issues/sync/runs?limit=15');
    var r = d.runs || [];
    $('#syRunTbl').innerHTML = r.length ? (
      '<thead><tr><th>#</th><th>Started</th><th>By</th><th>From</th><th>Status</th>' +
      '<th class="n">Found</th><th class="n">New</th><th class="n">Updated</th><th>Note</th></tr></thead><tbody>' +
      r.map(function (x) {
        return '<tr><td class="m">' + x.id + '</td><td class="m">' + dt(x.started_at) + '</td>' +
          '<td>' + esc(x.trigger === 'schedule' ? 'schedule' : (x.actor || 'desk')) + '</td>' +
          '<td>' + esc((x.exchanges || []).join(', ')) + '</td>' +
          '<td><span class="chip ' + (x.status === 'ok' ? 'open' : x.status === 'running' ? 'soon' : x.status === 'partial' ? 'soon' : 'closed') + '">' +
          esc(x.status) + '</span></td>' +
          '<td class="n">' + (x.found || 0) + '</td><td class="n">' + (x.inserted || 0) + '</td>' +
          '<td class="n">' + (x.updated || 0) + '</td>' +
          '<td class="sm">' + esc(x.error || '') + '</td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="empty">No pull has run yet.</td></tr></tbody>';
  } catch (e) { toast('Pull history failed', e.message, 'bad'); }
}

function loadSync() { loadSyncStatus(); loadSyncRuns(); }

/* ================================================================= circulars ===
 * NSE publishes a circular for every OFS, and an RSS feed of every circular. A feed
 * exists to be polled, so this is licensed and free — unlike scraping their pages,
 * which is why EXCHANGE_WEB_FETCH stays off.
 *
 * It answers ONE question: is there an OFS we have not set up? The numbers are in
 * the PDF and a human still enters them.
 */
async function loadCirculars() {
  try {
    var st = $('#cirStatus').value;
    var d = await api('/circulars' + (st ? '?status=' + encodeURIComponent(st) : ''));
    var r = d.circulars || [];
    var f = (d.status && d.status.feed) || {};

    $('#cirFeed').textContent = !d.status.enabled ? 'Watch is off'
      : f.last_ok_at ? ('NSE checked ' + dt(f.last_ok_at) +
          (f.last_status === 304 ? ' · unchanged' : '') +
          (d.status.alert_email ? ' · alerts to ' + d.status.alert_email : ' · no email alert set'))
      : 'Not checked yet';

    var unread = Number(d.status.counts && d.status.counts.unreviewed) || 0;
    var badge = $('#cirBadge');
    badge.textContent = unread;
    badge.classList.toggle('hide', !unread);

    $('#cirTbl').innerHTML = r.length ? (
      '<thead><tr><th>Published</th><th>Company</th><th>Circular</th><th>Dept</th>' +
      '<th>Match</th><th>Status</th><th></th></tr></thead><tbody>' +
      r.map(function (c) {
        var conf = c.is_ofs ? 3 : 0;
        return '<tr><td class="m">' + dt(c.published_at) + '</td>' +
          '<td><b>' + esc(c.company || '—') + '</b></td>' +
          '<td class="sm"><a href="' + esc(c.link) + '" target="_blank" rel="noopener">' +
            esc(c.title) + '</a></td>' +
          '<td class="m">' + esc(c.department || '') + '</td>' +
          '<td><span class="conf"><i style="width:' + (conf / 3 * 100) + '%"></i></span></td>' +
          '<td><span class="chip ' + (c.status === 'new' ? 'soon' : c.status === 'imported' ? 'open' : 'grey') + '">' +
            esc(c.status) + '</span>' +
            (c.handled_by ? '<div class="sm">' + esc(c.handled_by) + '</div>' : '') + '</td>' +
          '<td>' +
            (c.status === 'new'
              ? '<button class="mini" data-cirnew="' + c.id + '">Set up issue</button> ' +
                '<button class="mini" data-cirdone="' + c.id + '">Reviewed</button> ' +
                '<button class="mini" data-cirskip="' + c.id + '">Ignore</button>'
              : '<button class="mini" data-cirreopen="' + c.id + '">Reopen</button>') +
          '</td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="empty">' +
        (st === 'new' ? 'Nothing waiting — no unreviewed OFS circular.'
                      : 'No circular recorded yet. Press “Check NSE now”.') +
        '</td></tr></tbody>';
  } catch (e) { toast('Circulars failed', e.message, 'bad'); }
}

async function pollCirculars() {
  var b = $('#cirPoll');
  b.disabled = true; b.textContent = 'Checking…';
  try {
    var r = await api('/circulars/poll', { method: 'POST' });
    toast(r.inserted ? r.inserted + ' new OFS circular(s)' : 'Nothing new',
      r.notModified ? 'NSE reports the feed unchanged since the last check.'
        : r.error ? r.error
        : (r.items || 0) + ' circular(s) in the feed, ' + (r.matched || 0) + ' matched OFS.',
      r.error ? 'bad' : r.inserted ? 'ok' : 'warn');
    loadCirculars();
  } catch (e) {
    toast('Check failed', (e.body && e.body.message) || e.message, 'bad');
  } finally {
    b.disabled = false; b.textContent = 'Check NSE now';
  }
}

async function setCircular(id, status) {
  try {
    await api('/circulars/' + id, { method: 'PUT', body: { status: status } });
    loadCirculars();
  } catch (e) { toast('Could not update', e.message, 'bad'); }
}

/** "Set up issue" — mark it, then open the manual issue form with the name filled in. */
async function circularToIssue(id, company, link, title) {
  await setCircular(id, 'imported');
  // Remember the circular so the issue, once saved, carries the document that
  // justifies its floor price and windows.
  STATE.fromCircular = { id: id, link: link, title: title };
  showMTab('issues');
  issueForm();
  var el = $('#fCompany');
  if (el && company && company !== '—') { el.value = company; }
  var sym = $('#fSymbol');
  if (sym) sym.focus();
  if (link) toast('Circular remembered', 'It will be attached to the issue when you save.', 'ok');
}

/* ===================================================================== audit ===
 * Read-only by construction. The point is that compliance can answer "who changed
 * this, when, and from where" without a DBA — including whether a bid came from the
 * client, their AP or the back office, which is on the bid row, not the actor.
 */
var AUDIT = { offset: 0, limit: 100, total: 0, rows: [] };

function auditQuery(offset) {
  var q = [];
  var add = function (k, v) { if (v) q.push(k + '=' + encodeURIComponent(v)); };
  add('area', $('#auArea').value);
  add('placed_by', $('#auPlacedBy').value);
  add('actor', $('#auActor').value.trim());
  add('from', $('#auFrom').value);
  add('to', $('#auTo').value);
  add('q', $('#auQ').value.trim());
  q.push('limit=' + AUDIT.limit);
  q.push('offset=' + (offset || 0));
  return '/audit?' + q.join('&');
}

/** What actually changed, in words — a raw JSON blob is not a review. */
function auditDiff(e) {
  var b = e.before || {}, a = e.after || {};
  if (!e.before && !e.after) return '';
  if (!e.before) {
    var keys = ['symbol', 'client_ucc', 'category', 'qty', 'price', 'is_cutoff', 'value', 'available', 'status'];
    return keys.filter(function (k) { return a[k] != null; })
      .map(function (k) { return k + ' ' + a[k]; }).join(' · ');
  }
  var out = [];
  Object.keys(a).forEach(function (k) {
    if (['updated_at', 'created_at', 'id'].indexOf(k) >= 0) return;
    var was = b[k], now = a[k];
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      out.push(k + ': ' + (was == null ? '—' : was) + ' → ' + (now == null ? '—' : now));
    }
  });
  return out.join(' · ') || 'no field changed';
}

function renderAudit() {
  var r = AUDIT.rows;
  $('#auditTbl').innerHTML = r.length ? (
    '<thead><tr><th>When</th><th>Who</th><th>Source</th><th>Action</th><th>On</th>' +
    '<th>What changed</th><th>IP</th></tr></thead><tbody>' +
    r.map(function (e) {
      return '<tr><td class="m">' + dt(e.at) + '</td>' +
        '<td>' + esc(e.actor || '—') + '</td>' +
        '<td>' + (e.placed_by_label ? '<span class="chip grey">' + esc(e.placed_by_label) + '</span>' : '') + '</td>' +
        '<td><b>' + esc(e.action) + '</b></td>' +
        '<td class="m">' + esc(e.entity) + (e.entity_id ? ' #' + esc(e.entity_id) : '') + '</td>' +
        '<td class="sm">' + esc(auditDiff(e)) + '</td>' +
        '<td class="m sm">' + esc(e.ip || '') + '</td></tr>';
    }).join('') + '</tbody>'
  ) : '<tbody><tr><td class="empty">Nothing recorded for those filters.</td></tr></tbody>';

  var from = AUDIT.total ? AUDIT.offset + 1 : 0;
  var to = Math.min(AUDIT.offset + AUDIT.limit, AUDIT.total);
  $('#auCount').textContent = AUDIT.total ? (from + '–' + to + ' of ' + AUDIT.total) : 'nothing recorded';
  $('#auPrev').disabled = AUDIT.offset <= 0;
  $('#auNext').disabled = to >= AUDIT.total;
}

async function loadAudit(offset) {
  try {
    var d = await api(auditQuery(offset));
    AUDIT.offset = d.offset; AUDIT.total = d.total; AUDIT.rows = d.entries || [];
    var sel = $('#auArea');
    if (sel.options.length <= 1 && d.areas) {
      sel.innerHTML = '<option value="">All areas</option>' + d.areas.map(function (a) {
        return '<option value="' + esc(a.key) + '">' + esc(a.label) + '</option>';
      }).join('');
    }
    renderAudit();
  } catch (e) { toast('Audit failed', e.message, 'bad'); }
}

/** Export what is on screen, filters and all — compliance asks for a file. */
function auditCsv() {
  var head = ['at', 'actor', 'source', 'action', 'entity', 'entity_id', 'changed', 'ip'];
  var lines = [head.join(',')].concat(AUDIT.rows.map(function (e) {
    return [e.at, e.actor, e.placed_by_label || '', e.action, e.entity, e.entity_id || '',
            auditDiff(e), e.ip || ''].map(csvCell).join(',');
  }));
  downloadText('ofs_audit_' + new Date().toISOString().slice(0, 10) + '.csv', lines.join('\r\n'));
}

function csvCell(v) {
  var s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}


async function loadMargins() {
  try {
    var d = await api('/margin');
    var r = d.margins || [];
    $('#marginTbl').innerHTML = r.length ? (
      '<thead><tr><th>UCC</th><th class="n">Available</th><th class="n">Used</th><th class="n">Free</th>' +
      '<th>Source</th><th>Updated</th><th>By</th><th></th></tr></thead><tbody>' +
      r.map(function (m) {
        return '<tr><td class="m">' + esc(m.client_ucc) + '</td>' +
          '<td class="n">' + inr(m.available, 0) + '</td><td class="n">' + inr(m.used, 0) + '</td>' +
          '<td class="n">' + inr(m.free, 0) + '</td><td>' + esc(m.source) + '</td>' +
          '<td class="m">' + dt(m.updated_at) + '</td><td>' + esc(m.updated_by || '') + '</td>' +
          '<td><button class="mini" data-mglog="' + esc(m.client_ucc) + '">History</button></td></tr>';
      }).join('') + '</tbody>'
    ) : '<tbody><tr><td class="empty">No margin snapshot loaded. RMS has no available-margin read API yet — set margins here or via CSV.</td></tr></tbody>';
  } catch (e) { toast('Margins failed', e.message, 'bad'); }
}

/**
 * One margin row per client — a new figure REPLACES the old one, and the change is
 * kept here. So "what was their margin when that bid was placed?" is answerable
 * months later without keeping a row per snapshot on the live table.
 */
async function marginHistory(ucc) {
  try {
    var d = await api('/margin/' + encodeURIComponent(ucc) + '/log');
    var r = d.log || d.rows || [];
    $('#mgHistory').innerHTML =
      '<h2 class="sec">Margin history — ' + esc(ucc) + '</h2>' +
      '<div class="wrap"><table>' +
      (r.length
        ? '<thead><tr><th>When</th><th class="n">From</th><th class="n">To</th>' +
          '<th class="n">Change</th><th>Source</th><th>By</th><th>Note</th></tr></thead><tbody>' +
          r.map(function (x) {
            var d1 = Number(x.new_value) - Number(x.old_value || 0);
            return '<tr><td class="m">' + dt(x.at) + '</td>' +
              '<td class="n">' + (x.old_value == null ? '—' : inr(x.old_value, 0)) + '</td>' +
              '<td class="n">' + inr(x.new_value, 0) + '</td>' +
              '<td class="n" style="color:' + (d1 < 0 ? 'var(--red)' : 'var(--green)') + '">' +
              (d1 >= 0 ? '+' : '') + inr(d1, 0) + '</td>' +
              '<td>' + esc(x.source || '') + '</td><td>' + esc(x.actor || '') + '</td>' +
              '<td class="sm">' + esc(x.note || '') + '</td></tr>';
          }).join('') + '</tbody>'
        : '<tbody><tr><td class="empty">No change recorded for ' + esc(ucc) + ' yet.</td></tr></tbody>') +
      '</table></div>';
    $('#mgHistory').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { toast('History failed', e.message, 'bad'); }
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
      'Windows are read in the browser’s timezone (IST). Rows are posted one by one — a duplicate symbol/ISIN for the same day is rejected by the database.',
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
/* ------------------------------------------------------------ issue detail --
 * One builder, three places: the row expander in the Archive table, the standalone
 * window, and the desk's own drill-down. `full` decides whether the bid/file/
 * allotment tables come with it — a summary that dumps 400 bid rows into the table
 * you were reading is not a summary.
 */
function issueSummaryHtml(d) {
  var i = d.issue;
  var money = function (k, v) {
    return '<div class="f"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  };
  return '<div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">' +
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
  '</div>';
}

/**
 * The paperwork. A link opens the exchange's own page; an uploaded file is streamed
 * back through the API, never from a static mount, so it stays behind the same
 * session and page grant as everything else.
 */
function docsHtml(d) {
  var list = d.docs || [];
  var id = d.issue.id;
  return '<h2 class="sec">Announcement &amp; documents (' + list.length + ')</h2>' +
    '<div class="docs">' +
      (list.length ? list.map(function (x) {
        var href = x.storage === 'file'
          ? '/api/issues/' + id + '/docs/' + x.id + '/file'
          : x.url;
        return '<div class="doc">' +
          '<span class="ic">' + (x.storage === 'file' ? 'PDF' : 'WEB') + '</span>' +
          '<div class="tx"><a href="' + esc(href) + '" target="_blank" rel="noopener"><b>' +
            esc(x.title) + '</b></a>' +
            '<div class="sub">' + esc(x.source) + ' · ' + esc(x.kind) +
            (x.bytes ? ' · ' + Math.max(1, Math.round(x.bytes / 1024)) + ' KB' : '') +
            ' · added ' + dt(x.added_at) + (x.added_by ? ' by ' + esc(x.added_by) : '') + '</div>' +
            (x.storage === 'link' ? '<div class="sub m">' + esc(x.url) + '</div>' : '') +
          '</div>' +
          '<button class="mini" data-docdel="' + x.id + '" data-docissue="' + id + '">Remove</button>' +
        '</div>';
      }).join('') : '<div class="note">No document attached yet. The circular or member ' +
        'notice is what justifies the floor price and the windows — attach it here.</div>') +
      '<div class="bar" style="margin-top:10px">' +
        '<input type="url" data-doclink="' + id + '" placeholder="https://… circular or notice link" style="flex:1 1 320px">' +
        '<input type="text" data-doctitle="' + id + '" placeholder="Title (optional)" style="flex:0 1 200px">' +
        '<button class="mini" data-docadd="' + id + '">Attach link</button>' +
        '<button class="mini" data-docup="' + id + '">Upload PDF</button>' +
      '</div>' +
    '</div>';
}

function issueTablesHtml(d) {
  return '<h2 class="sec">Files generated (' + d.exports.length + ')</h2>' +
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
    (d.pii_unmasked ? '' : '<div class="note">Client PII is masked, as everywhere else.</div>');
}

function issueHeadHtml(d, opts) {
  var i = d.issue;
  return '<div class="bar"><b style="font-size:15px">' + esc(i.symbol) + '</b>' +
    '<span style="color:var(--muted)">' + esc(i.company || '') + '</span>' +
    '<span class="tag">' + esc(i.exchange) + '</span>' +
    (i.archived_at ? '<span class="chip closed">Archived ' + dt(i.archived_at) +
      (i.archived_by ? ' by ' + esc(i.archived_by) : '') + '</span>' : '') +
    '<div class="sp"></div>' +
    (opts && opts.controls ? opts.controls : '') + '</div>' +
    (i.archive_reason ? '<div class="note">' + esc(i.archive_reason) + '</div>' : '');
}

/**
 * The expander under the row itself. Opens as a SUMMARY — the detail tables are one
 * click further, and a new window is one click sideways for anyone comparing two
 * issues side by side.
 */
async function toggleIssueRow(tr, id) {
  var open = tr.nextElementSibling;
  if (open && open.classList.contains('rowdet')) { open.remove(); return; }
  $$('.rowdet').forEach(function (x) { x.remove(); });

  var det = document.createElement('tr');
  det.className = 'rowdet';
  det.innerHTML = '<td colspan="' + tr.children.length + '"><div class="rowdet-in">Loading…</div></td>';
  tr.parentNode.insertBefore(det, tr.nextSibling);

  try {
    var d = await api('/issues/' + id + '/summary');
    var box = det.querySelector('.rowdet-in');
    box.innerHTML = issueHeadHtml(d, { controls:
        '<button class="mini" data-expand="' + id + '">Expand</button> ' +
        '<button class="mini" data-window="' + id + '">Open in new window</button> ' +
        '<button class="mini" data-collapse="1">Close</button>' }) +
      issueSummaryHtml(d) + docsHtml(d) + '<div class="rowdet-more hide"></div>';

    box.addEventListener('click', function (e) {
      var x = e.target.closest('[data-expand]');
      if (x) {
        var more = box.querySelector('.rowdet-more');
        var showing = !more.classList.contains('hide');
        if (showing) { more.classList.add('hide'); x.textContent = 'Expand'; }
        else { more.innerHTML = issueTablesHtml(d); more.classList.remove('hide'); x.textContent = 'Collapse'; }
        return;
      }
      if (e.target.closest('[data-window]')) { openIssueWindow(id); return; }
      if (e.target.closest('[data-collapse]')) det.remove();
    });
  } catch (e) {
    det.querySelector('.rowdet-in').innerHTML = '<div class="note bad">' + esc(e.message) + '</div>';
  }
}

/* ---- document actions, delegated so they work in the expander, the archive
   drill-down and the standalone window alike ---- */
async function docAddLink(id, url, title) {
  if (!url) return toast('Nothing to attach', 'Paste the circular or notice link first.', 'bad');
  try {
    await api('/issues/' + id + '/docs', { method: 'POST',
      body: { url: url, title: title || 'Announcement', kind: 'circular' } });
    toast('Attached', 'The link is now on this issue.', 'ok');
    refreshOpenDetail(id);
  } catch (e) { toast('Could not attach', (e.body && e.body.message) || e.message, 'bad'); }
}

function docUpload(id) {
  var f = document.createElement('input');
  f.type = 'file';
  f.accept = '.pdf,.zip,.png,.jpg,.jpeg,application/pdf,application/zip,image/png,image/jpeg';
  f.addEventListener('change', async function () {
    var file = f.files && f.files[0];
    if (!file) return;
    try {
      var qs = '?title=' + encodeURIComponent(file.name) + '&name=' + encodeURIComponent(file.name) +
               '&kind=notice';
      var r = await fetch('/api/issues/' + id + '/docs/upload' + qs, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'application/pdf' },
        body: file
      });
      var data = {};
      try { data = await r.json(); } catch (e2) {}
      if (!r.ok) throw new Error(data.message || ('Upload failed (' + r.status + ')'));
      toast('Uploaded', file.name + ' is attached to this issue.', 'ok');
      refreshOpenDetail(id);
    } catch (e) { toast('Upload failed', e.message, 'bad'); }
  });
  f.click();
}

async function docRemove(issueId, docId) {
  if (!window.confirm('Remove this document from the issue?')) return;
  try {
    await api('/issues/' + issueId + '/docs/' + docId, { method: 'DELETE' });
    refreshOpenDetail(issueId);
  } catch (e) { toast('Could not remove', e.message, 'bad'); }
}

/** Re-open whichever view is currently showing this issue. */
function refreshOpenDetail(id) {
  var row = document.querySelector('[data-detail="' + id + '"]');
  if (row) { var tr = row.closest('tr'); toggleIssueRow(tr, id); toggleIssueRow(tr, id); return; }
  if ($('#arDetail') && $('#arDetail').innerHTML) openArchived(id);
}

function openIssueWindow(id) {
  window.open('/backoffice/issue.html?id=' + encodeURIComponent(id), '_blank', 'noopener');
}

async function openArchived(id) {
  try {
    var d = await api('/issues/' + id + '/summary');
    $('#arDetail').innerHTML = '<div class="card" style="margin-top:14px">' +
      issueHeadHtml(d, { controls:
        '<button class="mini" data-window="' + id + '">Open in new window</button> ' +
        '<button class="mini" id="arClose">Close</button>' }) +
      issueSummaryHtml(d) + docsHtml(d) + issueTablesHtml(d) + '</div>';
    $('#arClose').addEventListener('click', function () { $('#arDetail').innerHTML = ''; });
    var w = $('#arDetail').querySelector('[data-window]');
    if (w) w.addEventListener('click', function () { openIssueWindow(id); });
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
    toast('Restored', 'The issue is back in the OFS BackOffice.', 'ok');
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
 * signs in directly at /backoffice/login.html against the same platform account. Either
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
      showGate('No access to the OFS BackOffice',
        'Your account is signed in, but the ' + (me.user.role || 'assigned') +
        ' role does not include the OFS BackOffice.',
        'An administrator grants the "ofs-desk" page to your role in the Admin console.');
      return false;
    }
    return true;
  } catch (e) {
    if (e.status === 401) {
      // No session: go straight to the sign-in page rather than showing a wall
      // that only tells the user where the door is.
      var stale = e.body && e.body.error === 'session_superseded';
      location.replace('/backoffice/login.html' + (stale ? '?reason=superseded' : ''));
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
  $('#syRun').addEventListener('click', function () { startSync(); });
  $('#scSave').addEventListener('click', saveSchedule);
  $('#auGo').addEventListener('click', function () { loadAudit(0); });
  $('#cirPoll').addEventListener('click', pollCirculars);

  // Document controls appear inside markup that is rebuilt constantly (the row
  // expander, the archive drill-down), so delegate from the document rather than
  // re-binding after every render.
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-docadd]');
    if (add) {
      var id = add.dataset.docadd;
      var scope = add.closest('.docs') || document;
      docAddLink(id,
        (scope.querySelector('[data-doclink]') || {}).value,
        (scope.querySelector('[data-doctitle]') || {}).value);
      return;
    }
    var up = e.target.closest('[data-docup]');
    if (up) { docUpload(up.dataset.docup); return; }
    var del = e.target.closest('[data-docdel]');
    if (del) docRemove(del.dataset.docissue, del.dataset.docdel);
  });
  $('#cirStatus').addEventListener('change', loadCirculars);
  $('#cirTbl').addEventListener('click', function (e) {
    var n = e.target.closest('[data-cirnew]');
    if (n) {
      var row = n.closest('tr');
      var a = row.querySelector('a[href]');
      circularToIssue(n.dataset.cirnew, row.children[1].textContent.trim(),
        a ? a.href : null, a ? a.textContent.trim() : null);
      return;
    }
    var d = e.target.closest('[data-cirdone]');   if (d) return setCircular(d.dataset.cirdone, 'reviewed');
    var s2 = e.target.closest('[data-cirskip]');  if (s2) return setCircular(s2.dataset.cirskip, 'ignored');
    var r = e.target.closest('[data-cirreopen]'); if (r) return setCircular(r.dataset.cirreopen, 'new');
  });
  $('#auQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadAudit(0); });
  ['#auArea', '#auPlacedBy', '#auFrom', '#auTo'].forEach(function (sel) {
    $(sel).addEventListener('change', function () { loadAudit(0); });
  });
  $('#auPrev').addEventListener('click', function () { loadAudit(Math.max(0, AUDIT.offset - AUDIT.limit)); });
  $('#auNext').addEventListener('click', function () { loadAudit(AUDIT.offset + AUDIT.limit); });
  $('#auCsv').addEventListener('click', auditCsv);
  $('#marginTbl').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mglog]');
    if (b) marginHistory(b.dataset.mglog);
  });
  $('#sySchedOpen').addEventListener('click', function () { $('#sySched').classList.toggle('hide'); });
  $('#arGo').addEventListener('click', loadArchive);
  $('#arQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadArchive(); });
  $('#arRun').addEventListener('click', runArchive);
  $('#archiveTbl').addEventListener('click', function (e) {
    var d = e.target.closest('[data-detail]');
    if (d) { toggleIssueRow(d.closest('tr'), d.dataset.detail); return; }
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

// app.js is also loaded by issue.html purely for its builders and api(); booting the
// desk there would bind handlers to elements that do not exist. The tab strip is the
// marker for "this is the desk".
document.addEventListener('DOMContentLoaded', function () {
  if (document.getElementById('tabs')) boot();
});
