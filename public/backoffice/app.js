'use strict';
/* OFS desk UI. CSP-safe: no inline script, no external CDN, no chart library. */

var $  = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

var TOKEN = null;                      // set by the host shell; falls back to the cookie session
var ME = null;                         // /api/me — the signed-in account and its page grants

/**
 * Page grants, read exactly the way middleware/pageAccess.js reads them, so the
 * screen and the server never disagree about what this account may do.
 *
 * The OFS module is granted whole: any grant on any OFS page, at any level, confers
 * full access to all of OFS. So in practice this returns full for anyone who reached
 * this screen at all — the sweep below only ever fires for an account that holds no
 * OFS grant, which is already stopped at the gate. It stays because the server-side
 * rule can change without this file, and a disabled button beats a 403 either way.
 *
 * This is a courtesy, not a control: the server checks every write regardless.
 */
var GRANT_LEVELS = { view: 1, edit: 2, pii: 3 };
var MODULE_PAGES = ['ofs-desk', 'ofs-masters'];
function grantPages() { return (ME && ME.permissions && ME.permissions.pages) || []; }
function hasModuleAccess() {
  return grantPages().some(function (e) { return MODULE_PAGES.indexOf(String(e).split(':')[0]) >= 0; });
}
function grantLevel(page) {
  var pages = grantPages();
  if (pages.indexOf('*') >= 0) return GRANT_LEVELS.pii;
  if (MODULE_PAGES.indexOf(page) >= 0 && hasModuleAccess()) return GRANT_LEVELS.pii;
  var best = 0;
  for (var i = 0; i < pages.length; i++) {
    var bits = String(pages[i]).split(':');
    if (bits[0] !== page) continue;
    best = Math.max(best, GRANT_LEVELS[String(bits[1] || 'view').toLowerCase()] || GRANT_LEVELS.view);
  }
  return best;
}
function canEdit(page) { return grantLevel(page) >= GRANT_LEVELS.edit; }
var STATE = { dash: null, issues: [], book: [], editing: null, timer: null, tab: 'dash', mtab: 'issues',
              settings: {} };

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
/**
 * A timestamp for people: 11-Sep-2026 03:15 PM IST.
 *
 * Always IST, never the viewer's timezone. A desk in another timezone reading a
 * bidding window in local time is a mis-read waiting to happen, and the exchange
 * windows are defined in IST — so that is what is shown, with the zone named so
 * nobody has to wonder.
 */
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});
function istParts(v) {
  var d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  var p = {};
  IST_PARTS.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  p.hour = String(Number(p.hour) % 24).padStart(2, '0');    // en-GB gives '24' at midnight
  return p;
}
function dtDate(v) {
  var p = istParts(v);
  return p ? p.day + '-' + MONTHS[Number(p.month) - 1] + '-' + p.year : '—';
}
function dtTime(v) {
  var p = istParts(v);
  if (!p) return '—';
  var h = Number(p.hour);
  var ampm = h < 12 ? 'AM' : 'PM';
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return String(h12).padStart(2, '0') + ':' + p.minute + ' ' + ampm;
}
function dt(v) {
  if (!v) return '—';
  var p = istParts(v);
  return p ? dtDate(v) + ' ' + dtTime(v) : '—';
}
/** With the zone spelled out — for a window, where being wrong matters most. */
function dtz(v) { return v ? dt(v) + ' IST' : '—'; }

/** Today in IST as YYYY-MM-DD — what a date input expects, and what the server compares. */
function todayIST() {
  var p = istParts(new Date());
  return p.year + '-' + p.month + '-' + p.day;
}

/**
 * The as-on value to actually send.
 *
 * The box always SHOWS a date, because an empty date box reads as broken. But today
 * is not a filter — it is the normal view — so it is sent as nothing. Otherwise the
 * bid book would quietly drop a live bid placed yesterday on the HNI leg, which is a
 * bid that still has to reach the exchange file.
 */
function asOnParam(sel) {
  var el = $(sel);
  var v = el && el.value;
  return v && v !== todayIST() ? v : '';
}

/** Put today in a date box that has no value yet. */
function primeDateBox(sel) {
  var el = $(sel);
  if (el && !el.value) el.value = todayIST();
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

/* ================================================================ pagination ===
 * Ten rows a page, everywhere. One helper rather than eight implementations: give
 * it the rows and a renderer, it returns the page's rows and draws the control.
 *
 * Deliberately client-side. Every list here is bounded — an issue master is tens of
 * rows, a bid book hundreds — so the whole set is already in hand, and paging in the
 * browser keeps sorting and filtering instant. The audit trail is the exception: it
 * grows without limit and pages on the server.
 */
var PAGE_SIZE = 10;
var PAGES = {};                       // key -> current page index

function pageOf(key, rows) {
  var total = rows.length;
  var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  var at = Math.min(PAGES[key] || 0, pages - 1);
  PAGES[key] = at;
  return { rows: rows.slice(at * PAGE_SIZE, at * PAGE_SIZE + PAGE_SIZE),
           at: at, pages: pages, total: total,
           from: total ? at * PAGE_SIZE + 1 : 0,
           to: Math.min(total, at * PAGE_SIZE + PAGE_SIZE) };
}

/** The control itself. Hidden entirely when everything fits on one page. */
function pagerHtml(key, p, noun) {
  if (p.total <= PAGE_SIZE) return '';
  return '<div class="pager" data-pager="' + esc(key) + '">' +
    '<span class="range">' + p.from + '–' + p.to + ' of ' + p.total + ' ' + esc(noun || 'rows') + '</span>' +
    '<div class="sp"></div>' +
    '<button class="mini" data-pg="first"' + (p.at ? '' : ' disabled') + '>« First</button>' +
    '<button class="mini" data-pg="prev"' + (p.at ? '' : ' disabled') + '>‹ Prev</button>' +
    '<span class="of">Page ' + (p.at + 1) + ' of ' + p.pages + '</span>' +
    '<button class="mini" data-pg="next"' + (p.at < p.pages - 1 ? '' : ' disabled') + '>Next ›</button>' +
    '<button class="mini" data-pg="last"' + (p.at < p.pages - 1 ? '' : ' disabled') + '>Last »</button>' +
    '</div>';
}

/** Wire every pager once, from the document — the tables are rebuilt constantly. */
function initPagers() {
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-pg]');
    if (!b) return;
    var wrap = b.closest('[data-pager]');
    if (!wrap) return;
    var key = wrap.dataset.pager;
    var p = PAGERS[key];
    if (!p) return;
    var last = Math.max(0, p.pages - 1);
    var at = PAGES[key] || 0;
    PAGES[key] = b.dataset.pg === 'first' ? 0
      : b.dataset.pg === 'prev' ? Math.max(0, at - 1)
      : b.dataset.pg === 'next' ? Math.min(last, at + 1)
      : last;
    if (typeof p.redraw === 'function') p.redraw();
  });
}
var PAGERS = {};                      // key -> { pages, redraw }

/**
 * Render a paged table in one call.
 *
 *   pagedTable('issues', $('#issueTbl'), rows, function (page) { return HEAD + page.map(...) },
 *              'issues', loadIssues, 'No issue in the master yet.')
 *
 * The builder receives only the rows for the current page, so every existing table
 * body keeps its exact markup — the change at each call site is one wrapper, not a
 * rewrite of the row HTML.
 */
function pagedTable(key, tbl, rows, build, noun, redraw, emptyMsg) {
  var p = pageOf(key, rows);
  PAGERS[key] = { pages: p.pages, redraw: redraw };
  tbl.innerHTML = p.total
    ? build(p.rows)
    : '<tbody><tr><td class="empty">' + esc(emptyMsg || 'Nothing to show.') + '</td></tr></tbody>';

  // The pager lives after the scrolling box, not inside it.
  var host = tbl.closest('.wrap') || tbl;
  var existing = host.parentNode.querySelector('[data-pager="' + key + '"]');
  if (existing) existing.remove();
  var html = pagerHtml(key, p, noun);
  if (html) host.insertAdjacentHTML('afterend', html);

  // Rows are rebuilt on every page change, so any write control inside them has to
  // be re-checked against the account's grants — otherwise page 2 arrives enabled.
  applyGrants();
}

/** A filter changed — go back to page one, or the user stares at an empty page 4. */
function resetPage(key) { PAGES[key] = 0; }

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
  if (!res.ok) {
    var err = new Error((json && json.error) || res.statusText);
    err.status = res.status; err.body = json || {};
    // A 403 used to surface as the literal string "read_only", which tells a user
    // nothing about what to do next. OFS access is all or nothing, so all three of
    // these mean the same thing: the role holds no OFS grant.
    if (['read_only', 'forbidden', 'pii_forbidden'].indexOf(err.body.error) >= 0) {
      err.body.message = 'Your role does not hold the OFS grant, so it cannot use ' +
        pageLabel(err.body.page) + '. An administrator adds "' + (err.body.page || 'ofs-masters') +
        '" to the role in the Admin console — that one grant is the whole module.';
    }
    throw err;
  }
  return json;
}

/**
 * What went wrong, in a sentence.
 *
 * The desk used to get the raw field name — a toast reading "Save failed / symbol"
 * — which names a column, not a problem, and says nothing about what to do. Order
 * matters here: the server's own `message` is always the most specific thing
 * available, so it wins; the codes below are the fallback for anything that
 * predates it.
 */
var FIELD_LABELS = {
  symbol: 'Symbol', company: 'Company', isin: 'ISIN', series: 'Series', exchange: 'Exchange',
  bse_scrip_code: 'BSE scrip code', floor_price: 'Floor price', cut_price_min: 'Retail cut-off min',
  tick: 'Tick', lot: 'Lot', issue_qty: 'Issue qty', retail_qty: 'Retail reserved qty',
  discount_pct: 'Retail discount %', cutoff_flag: 'Cut-off bidding',
  hni_open: 'HNI open', hni_close: 'HNI close', ret_open: 'Retail open', ret_close: 'Retail close',
  issue_date: 'Trading day', status: 'Status', client_ucc: 'Client UCC', qty: 'Quantity',
  price: 'Price', category: 'Category'
};
function fieldLabel(f) { return FIELD_LABELS[f] || f; }

function apiMessage(e) {
  var b = (e && e.body) || {};
  if (b.message) return b.message;
  if (b.errors && b.errors.length) return b.errors.join(' ');

  switch (b.error) {
    case 'missing_field':
      return (b.fields && b.fields.length ? 'These are required: ' + b.fields.map(fieldLabel).join(', ')
                                          : fieldLabel(b.field) + ' is required') + '.';
    case 'validation_failed': return 'Some values were refused — check the highlighted fields.';
    case 'duplicate':         return 'A record with these details already exists.';
    case 'not_found':         return 'That record no longer exists. Refresh and try again.';
    case 'has_bids':          return 'This issue has ' + b.bids + ' bid(s), so it cannot be deleted. Archive it instead.';
    case 'unknown_client':    return 'No client found for ' + (b.ucc || 'that UCC') + '.';
    case 'unknown_issue':     return 'That issue no longer exists. Refresh the list.';
    case 'window_closed':     return 'Bidding is closed.';
    case 'server_error':      return 'The server hit an unexpected error. It has been logged — try again, and tell IT if it repeats.';
  }
  if (e && e.status === 401) return 'Your session has ended. Reload the page and sign in again.';
  if (e && e.status === 429) return 'Too many requests in a row. Wait a few seconds and try again.';
  if (e && /failed to fetch|networkerror|load failed/i.test(e.message || '')) {
    return 'The server did not respond — it may have just restarted. Reload the page and try again.';
  }
  return (e && e.message) || 'Something went wrong.';
}

/**
 * Ring the field(s) the server refused, so a long form does not have to be re-read
 * top to bottom. Cleared on the next attempt.
 */
function markFields(fields) {
  $$('.f .bad-field').forEach(function (el) { el.classList.remove('bad-field'); });
  (fields || []).forEach(function (f) {
    var el = document.getElementById(FIELD_INPUT_IDS[f] || '');
    if (el) el.classList.add('bad-field');
  });
  var first = $('.bad-field');
  if (first) { first.focus(); first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

/** Column name -> the input that carries it on the issue form. */
var FIELD_INPUT_IDS = {
  symbol: 'fSymbol', company: 'fCompany', isin: 'fIsin', exchange: 'fExch', series: 'fSeries',
  bse_scrip_code: 'fBseCode', floor_price: 'fFloor', cut_price_min: 'fCut', tick: 'fTick', lot: 'fLot',
  issue_qty: 'fIssueQty', retail_qty: 'fRetQty', discount_pct: 'fDiscount', cutoff_flag: 'fCutoffFlag',
  hni_open: 'fHniOpen', hni_close: 'fHniClose', ret_open: 'fRetOpen', ret_close: 'fRetClose',
  status: 'fStatus'
};

/** placed_by is four values now: desk | client | ap | branch. */
function placedByLabel(v) {
  return v === 'desk' ? 'Back office'
       : v === 'client' ? 'Client'
       : v === 'ap' ? 'AP'
       : v === 'branch' ? 'Branch'
       : (v || '');
}

function pageLabel(key) {
  if (key === 'ofs-masters') return 'Masters & Margins';
  if (key === 'ofs-desk') return 'the Bidding Desk';
  return key || 'this page';
}

/**
 * Disable every control marked data-grant="<page>" when the account cannot write it.
 * The attribute is data-GRANT, not data-edit: data-edit already carries a bid id on
 * the Modify button in the bid book, and a sweep over that would read the bid id as
 * a page key and disable the button.
 * Disabled rather than hidden: a read-only user should still be able to see that the
 * function exists and ask for the grant, rather than wonder where it went.
 */
function applyGrants() {
  if (!ME) return;          // grants unknown yet — never disable on a guess
  var blocked = {};
  $$('[data-grant]').forEach(function (el) {
    var page = el.getAttribute('data-grant');
    if (canEdit(page)) return;
    blocked[page] = true;
    el.disabled = true;
    el.classList.add('no-grant');
    el.title = 'Read-only: your role cannot change ' + pageLabel(page) + '.';
  });
  var box = $('#mastersReadOnly');
  if (box) {
    if (blocked['ofs-masters']) {
      box.innerHTML = '<b>Read-only.</b> Your role (' + esc((ME && ME.user && ME.user.role) || '—') +
        ') does not hold the OFS grant, so issues, margins, exchange pulls and ' +
        'settings are disabled. An administrator adds <code>ofs-masters</code> to ' +
        'the role in the Admin console — OFS access is all-or-nothing, so that one ' +
        'grant is the whole module.';
      box.classList.remove('hide');
    } else {
      box.classList.add('hide');
    }
  }
}

/* ---------------- tabs ---------------- */
function showTab(t) {
  STATE.tab = t;
  $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
  ['dash', 'book', 'place', 'export', 'masters', 'rules'].forEach(function (k) {
    $('#pane-' + k).classList.toggle('hide', k !== t);
  });
  if (t === 'book') loadBook();
  if (t === 'export') { loadExportLog(); previewExport(); }
  if (t === 'masters') loadMasters();
  if (t === 'rules') renderRules($('#rulesBox'));
}

/* ---------------- dashboard ---------------- */
function kpiCard(k, v, s) {
  return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' +
         '<div class="s">' + esc(s || '') + '</div></div>';
}

function issueCard(i) {
  var biddable = isBiddable(i);
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
      // On a past date the live status still shows — it is true — but what mattered
      // that day is said alongside it, or a "Closed" chip over that day's bids reads
      // as a contradiction.
      (i.open_on_scope ? '<span class="chip open" style="margin-left:6px">was open</span>' : '') +
    '</div>' +
    '<div class="grid2">' +
      '<div class="f"><div class="k">Floor</div><div class="v">' + rupee(i.floor_price) + '</div></div>' +
      '<div class="f"><div class="k">Retail cut-off min</div><div class="v">' + rupee(i.min_price_retail) + '</div></div>' +
      '<div class="f"><div class="k">Bids</div><div class="v">' + inr(i.bid_count, 0) + '</div></div>' +
      '<div class="f"><div class="k">Clients applied</div><div class="v">' + inr(i.client_count, 0) + '</div></div>' +
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
    // The windows, in full. A card that only counts down says when, never until when,
    // and the desk is the one who has to tell a client the date.
    '<div class="legend win">' +
      '<span>HNI <b>' + dt(i.hni_open) + '</b> → <b>' + dt(i.hni_close) + '</b></span>' +
      '<span>Retail <b>' + dt(i.ret_open) + '</b> → <b>' + dt(i.ret_close) + '</b> IST</span>' +
    '</div>' +
    '<div class="cdn" data-close="' + nextClose.toISOString() + '">closes in --:--:--</div>' +
    '<div class="bar" style="margin-top:10px">' +
      (biddable
        ? '<button class="btn" data-bidon="' + i.id + '">Bid on this issue</button>'
        : '<button class="btn" disabled title="' + esc(i.status_label) + '">Bidding closed</button>') +
    '</div>' +
  '</div>';
}

function renderDash(d) {
  var t = d.totals || {};
  var all = d.issues || [];
  /*
   * "Open" means open ON THE DAY SHOWN. For today and for the whole live book that
   * is the same as biddable-right-now; for a past date it is not, and the screen was
   * reporting 0 open issues above three bids placed on that very issue that day.
   */
  var onDay = all.length && all[0].open_on_scope !== null && all[0].open_on_scope !== undefined;
  var open = onDay
    ? all.filter(function (i) { return i.open_on_scope; })
    : all.filter(isBiddable);
  // Default to what can be bid on. A closed issue on the dashboard is history, and
  // history mixed in with the live book is how the wrong one gets picked.
  var showAll = $('#dashShowAll') && $('#dashShowAll').checked;
  var shown = showAll ? all : open;

  var scopeWord = d.scope === 'all' ? 'all live'
                : d.as_on ? 'on ' + dtDate(d.as_on + 'T00:00:00+05:30')
                : 'today';
  var live = d.all_live || {};
  // "Bids today" is not the same number as "bids in the file", and a desk that
  // reads one as the other generates a file it did not expect. Both, labelled.
  var alsoLive = d.scope === 'all' || !live.bids || live.bids === t.bids
    ? null
    : inr(live.bids, 0) + ' live in all · ' + crore(live.value);

  $('#kpis').innerHTML =
    kpiCard(onDay ? 'Open ' + scopeWord : 'Open issues', String(open.length),
      'of ' + all.length + ' tracked') +
    kpiCard('Bids ' + scopeWord, inr(t.bids, 0), alsoLive || 'placed') +
    // Distinct clients, not bids. One client bidding on three issues is one client
    // applied, and it is the number the desk is asked for.
    kpiCard('Clients ' + scopeWord, inr(t.clients, 0), 'unique UCCs applied') +
    kpiCard('Quantity ' + scopeWord, inr(t.qty, 0), 'shares bid') +
    kpiCard('Value ' + scopeWord, crore(t.value),
      alsoLive ? 'whole live book ' + crore(live.value) : 'across all issues') +
    kpiCard('Desk cut-off', esc((d.settings && d.settings.daily_cutoff) || '15:15'), 'IST daily');

  // The book in one line, split the way the exchange splits it.
  var rv = all.reduce(function (a, i) { return a + (Number(i.ret_value) || 0); }, 0);
  var hv = all.reduce(function (a, i) { return a + (Number(i.hni_value) || 0); }, 0);
  var rq = all.reduce(function (a, i) { return a + (Number(i.ret_qty) || 0); }, 0);
  var hq = all.reduce(function (a, i) { return a + (Number(i.hni_qty) || 0); }, 0);
  var sum = $('#dashSummary');
  if (sum) {
    sum.innerHTML = t.bids
      ? '<span><i class="dot r"></i>Retail <b>' + inr(rq, 0) + '</b> shares · <b>' + crore(rv) + '</b></span>' +
        '<span><i class="dot h"></i>HNI <b>' + inr(hq, 0) + '</b> shares · <b>' + crore(hv) + '</b></span>' +
        '<span>Total <b>' + inr(t.qty, 0) + '</b> shares · <b>' + crore(t.value) + '</b> from <b>' +
          inr(t.clients, 0) + '</b> client(s), ' + esc(scopeWord) + '</span>'
      : '<span>No bids ' + esc(scopeWord === 'all live' ? 'at all' : scopeWord) + '.' +
        (alsoLive ? ' <b>' + esc(alsoLive) + '</b> from earlier days.' : '') + '</span>';
  }

  var lbl = $('#dashShowAllLbl');
  if (lbl) lbl.textContent = 'Show closed too (' + (all.length - open.length) + ')';

  $('#issueCards').innerHTML = shown.length
    ? shown.map(issueCard).join('')
    : '<div class="empty">' + (all.length
        ? (onDay
            ? 'No OFS was open on ' + esc(scopeWord.replace(/^on /, '')) + '. Tick "Show closed too" to see the ' +
              all.length + ' tracked issue(s).'
            : 'No OFS is open for bidding right now. Tick "Show closed too" to see the ' +
              all.length + ' tracked issue(s).')
        : 'No OFS issue. Add one under Masters → Issues.') + '</div>';

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
    var d = await api('/dashboard' + dashQuery());
    STATE.dash = d;
    STATE.issues = d.issues || [];
    // The caps the bid form works from — retail cap, HNI minimum, cut-off — come
    // from the same payload rather than being hard-coded in two places.
    STATE.settings = d.settings || STATE.settings || {};
    renderDash(d);
    fillIssueSelects();
    refreshBidForm();
    markRefreshed(d.as_on ? 'pinned' : null);
    var dd = $('#dashDate');
    if (dd) dd.textContent = dtDate(d.server_time) + ' · ' + dtTime(d.server_time) + ' IST';
    // Say which day every figure on this screen is describing. Ambiguity here is
    // what made "6 live bids" and "No bids yet" look like a contradiction.
    var note = $('#dashAsOnNote');
    if (note) {
      note.textContent = d.scope === 'all' ? 'Every live bid'
        : d.as_on ? 'As on ' + dtDate(d.as_on + 'T00:00:00+05:30') + ' — auto-refresh paused'
        : "Today's bids only";
      note.classList.toggle('warn-tag', !!d.as_on || d.scope === 'all');
    }
    var wrap = $('#dashAsOnWrap');
    if (wrap) wrap.classList.toggle('hide', d.scope === 'all');
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

  // With nothing to bid on, leaving the form live invites filling it in and being
  // told "pick an issue" — which is not the user's mistake to fix.
  ['#pbIssue', '#pbUcc', '#pbCat', '#pbQty', '#pbType', '#pbPrice', '#pbCheck'].forEach(function (sel) {
    var el = $(sel); if (el) el.disabled = none;
  });

  // Every list gets the symbol AND the company; the bid form also gets the window
  // that is closing, because "which COALINDIA?" is a real question on a day with a
  // T and a T+1 leg open at once.
  var opts = STATE.issues.map(function (i) {
    return '<option value="' + i.id + '">' + esc(issueOptionLabel(i, false)) + '</option>';
  }).join('');
  ['#bkIssue', '#exIssue'].forEach(function (sel) {
    var el = $(sel); if (!el) return;
    var cur = el.value;
    el.innerHTML = '<option value="">All issues</option>' + opts;
    if (cur) el.value = cur;
  });

  var pb = $('#pbIssue');
  if (pb) {
    // Only what can actually be bid on. Offering a closed issue and then refusing
    // the bid wastes the one thing a desk has none of during a window.
    var live = STATE.issues.filter(isBiddable);
    var c = STATE.editing ? String(STATE.editing.issue_id) : pb.value;
    // An issue being modified stays selectable even if its window just closed,
    // otherwise the form silently jumps to a different issue mid-edit.
    if (STATE.editing && !live.some(function (i) { return String(i.id) === c; })) {
      var cur = STATE.issues.filter(function (i) { return String(i.id) === c; });
      live = cur.concat(live);
    }
    pb.innerHTML = live.length
      ? live.map(function (i) {
          return '<option value="' + i.id + '">' + esc(issueOptionLabel(i, true)) + '</option>';
        }).join('')
      : '<option value="">No OFS is open for bidding</option>';
    if (c) pb.value = c;
    renderIssueInfo();
  }
}

/** Is either window open, or about to be? Closed and suspended are not biddable. */
function isBiddable(i) {
  if (!i) return false;
  if (i.status && i.status !== 'Auto') return false;
  return i.ret_status === 'Open' || i.hni_status === 'Open'
      || i.ret_status === 'Upcoming' || i.hni_status === 'Upcoming';
}

/** "COALINDIA — Coal India Ltd · Retail closes 03 Sep 15:15" */
function issueOptionLabel(i, withWindow) {
  var base = i.symbol + ' — ' + (i.company || '');
  if (!withWindow) return base;
  var which = i.ret_status === 'Open' ? { w: 'Retail', t: i.ret_close }
            : i.hni_status === 'Open' ? { w: 'HNI', t: i.hni_close }
            : i.ret_status === 'Upcoming' ? { w: 'Retail opens', t: i.ret_open }
            : i.hni_status === 'Upcoming' ? { w: 'HNI opens', t: i.hni_open }
            : null;
  return which ? base + '  ·  ' + which.w + ' ' + dt(which.t) : base + '  ·  closed';
}

/** The issue currently selected on the bid form. */
function selectedIssue() {
  var id = $('#pbIssue') && $('#pbIssue').value;
  if (!id) return null;
  return (STATE.issues || []).find(function (i) { return String(i.id) === String(id); }) || null;
}

/**
 * The read-only panel beside the form. Everything a desk would otherwise have to
 * go and look up in Masters mid-window: the floor, the band, both windows, and
 * whether cut-off is allowed at all.
 */
function renderIssueInfo() {
  var box = $('#pbIssueInfo');
  if (!box) return;
  var i = selectedIssue();
  if (!i) {
    box.className = 'note';
    box.textContent = 'Choose an issue to see its floor, band, windows and status.';
    return;
  }
  var f = function (k, v) {
    return '<div class="f"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  };
  var money = function (v) { return v == null || v === '' ? '—' : rupee(v); };
  box.className = '';
  box.innerHTML =
    '<div class="bar" style="margin-bottom:8px"><b>' + esc(i.symbol) + '</b>' +
      '<span class="tag">' + esc(i.exchange) + '</span>' +
      '<span class="chip ' + chipCls(i.status_label) + '">' + esc(i.status_label) + '</span></div>' +
    '<div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">' +
      f('Company', esc(i.company || '—')) +
      f('ISIN', '<span class="m">' + esc(i.isin || '—') + '</span>') +
      f('Floor price', money(i.floor_price)) +
      f('Retail cut-off min', money(i.cut_price_min)) +
      f('Tick', inr(i.tick, 2)) +
      f('Lot', inr(i.lot, 0)) +
      (Number(i.discount_pct) ? f('Retail discount', inr(i.discount_pct, 2) + '%') : '') +
      f('HNI window', '<span class="m" style="font-size:11.5px">' + dt(i.hni_open) + ' → ' + dt(i.hni_close) + '</span>') +
      f('Retail window', '<span class="m" style="font-size:11.5px">' + dt(i.ret_open) + ' → ' + dt(i.ret_close) + '</span>') +
      f('Cut-off bids', i.cutoff_flag === false ? 'Not allowed' : 'Allowed (Retail only)') +
    '</div>' +
    (i.floor_price == null
      ? '<div class="note warn" style="margin-top:9px">The seller has not published a floor price for this issue yet. ' +
        'A cut-off bid cannot be valued against the retail cap until they do.</div>'
      : '');
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
/**
 * The totals under the bid book.
 *
 * A count and one rupee figure is not a total for this book: the exchange allots
 * Retail and Non-Retail separately, against separate reserved quantities, so a desk
 * that cannot see the split cannot tell whether either leg is covered. Cancelled
 * bids are counted apart rather than folded in — a cancelled bid is not part of the
 * book and must never be added to a figure that gets read as one.
 */
function renderBookTotals(rows) {
  var live = rows.filter(function (x) { return x.status !== 'Cancelled' && x.status !== 'Rejected'; });
  var dead = rows.length - live.length;
  var sum = function (list, f) { return list.reduce(function (t, x) { return t + (Number(f(x)) || 0); }, 0); };
  var byCat = function (cat) { return live.filter(function (x) { return x.category === cat; }); };

  var ret = byCat('Retail'), hni = byCat('HNI');
  var clients = new Set(live.map(function (x) { return x.client_ucc; })).size;

  var asOn = asOnParam('#bkAsOn');
  $('#bkCount').textContent = (asOn ? 'as on ' + dtDate(asOn + 'T00:00:00+05:30') + ' · ' : '') +
    live.length + ' bid(s) · ' + clients + ' client(s)';

  var cell = function (label, cls, list) {
    // Unique clients per leg. Retail and Non-Retail are allotted against separate
    // reserved quantities, so "how many clients are in each" is a real question and
    // the two counts do not add up to the overall one — a client can be in both.
    var uniq = new Set(list.map(function (x) { return x.client_ucc; })).size;
    return '<div class="tot ' + cls + '">' +
      '<div class="k">' + esc(label) + '</div>' +
      '<div class="n">' + inr(list.length, 0) + ' bid(s) · ' + inr(uniq, 0) + ' client(s)</div>' +
      '<div class="q">' + inr(sum(list, function (x) { return x.qty; }), 0) + ' shares</div>' +
      '<div class="v">' + rupee(sum(list, function (x) { return x.value; }), 0) + '</div>' +
    '</div>';
  };

  $('#bkTotals').innerHTML =
    cell('Retail', 'r', ret) +
    cell('HNI / Non-Retail', 'h', hni) +
    cell('Total', 't', live) +
    (dead ? '<div class="tot d"><div class="k">Cancelled / rejected</div>' +
      '<div class="n">' + inr(dead, 0) + ' bid(s)</div>' +
      '<div class="q">not in the book</div>' +
      '<div class="v">—</div></div>' : '');
}

/** The filters as a query string, shared by the table and the CSV. */
function bookQuery() {
  var q = [];
  if ($('#bkIssue').value) q.push('issue_id=' + encodeURIComponent($('#bkIssue').value));
  if ($('#bkCat').value) q.push('category=' + encodeURIComponent($('#bkCat').value));
  if ($('#bkStatus').value) q.push('status=' + encodeURIComponent($('#bkStatus').value));
  if ($('#bkQ').value.trim()) q.push('q=' + encodeURIComponent($('#bkQ').value.trim()));
  if ($('#bkBranch').value.trim()) q.push('branch_code=' + encodeURIComponent($('#bkBranch').value.trim()));
  if (asOnParam('#bkAsOn')) q.push('as_on=' + encodeURIComponent(asOnParam('#bkAsOn')));
  if ($('#bkStatus').value === 'Cancelled') q.push('include_cancelled=1');
  return q.join('&');
}

async function loadBook() {
  var q = bookQuery();
  try {
    var d = await api('/bids' + (q ? '?' + q : ''));
    var b = d.bids || [];
    STATE.book = b;
    renderBookTotals(b);
    pagedTable('bids', $('#bookTbl'), b, function (page) {
      // Thirteen columns scrolled sideways, which on the book is worse than on the
      // master: Status and the Modify/Cancel buttons were the ones off the edge.
      // The reference, the client and who placed it each fold into one cell.
      return '<thead><tr><th>Bid</th><th>Client</th><th>Branch</th><th>Cat</th>' +
      '<th class="n">Qty</th><th class="n">Price</th><th class="n">Value</th>' +
      '<th>Status</th><th></th></tr></thead><tbody>' +
      page.map(function (x) {
        return '<tr data-bid="' + x.id + '">' +
          '<td class="m">' + esc(x.ref) +
            '<div class="sub">' + esc(x.symbol || '') + '</div></td>' +
          '<td>' + esc(x.client_name || x.client_ucc) +
            '<div class="sub m">' + esc(x.client_ucc) +
            (x.pan ? ' · ' + esc(x.pan) : '') + '</div></td>' +
          '<td class="m">' + esc(x.branch_code || '—') + '</td>' +
          '<td><span class="tag ' + (x.category === 'Retail' ? 'ret' : 'hni') + '">' + esc(x.category) + '</span></td>' +
          '<td class="n">' + inr(x.qty, 0) + '</td>' +
          '<td class="n">' + (x.is_cutoff ? 'Cut-off' : inr(x.price, 2)) + '</td>' +
          '<td class="n">' + inr(x.value, 0) + '</td>' +
          '<td><span class="st ' + statusCls(x.status) + '">' + esc(x.status) + '</span>' +
            '<div class="sub">by ' + esc(placedByLabel(x.placed_by)) + '</div></td>' +
          '<td class="act">' + (x.status === 'Cancelled' ? '' :
            '<button class="mini" data-edit="' + x.id + '">Modify</button> ' +
            '<button class="mini" data-cancel="' + x.id + '">Cancel</button>') + '</td>' +
        '</tr>';
      }).join('') + '</tbody>' +
      // The page's own subtotal. Ten rows at a time means the figures above are for
      // the whole book, not for what is on screen — so say which is which.
      '<tfoot><tr><td colspan="4">This page</td>' +
        '<td class="n">' + inr(page.reduce(function (t, x) { return t + Number(x.qty || 0); }, 0), 0) + '</td>' +
        '<td></td>' +
        '<td class="n">' + inr(page.reduce(function (t, x) { return t + Number(x.value || 0); }, 0), 0) + '</td>' +
        '<td colspan="2"></td></tr></tfoot>';
    }, 'bids', loadBook, 'No bid matches this filter.');
  } catch (e) { toast('Bid book failed', e.message, 'bad'); }
}

/**
 * Withdraw a bid. Like placing one, this is done on a client's behalf, so the
 * client confirms it — the server answers 428 until they have.
 */
async function cancelBid(id) {
  if (!window.confirm('Withdraw this bid? The row is kept for audit.')) return;
  var body = { reason: 'desk cancel' };
  try {
    await api('/bids/' + id, { method: 'DELETE', body: body });
    toast('Bid withdrawn', 'The client may bid again for this scrip.', 'ok');
    loadBook(); loadDash();
    return;
  } catch (e) {
    if (!(e.status === 428 && e.body && e.body.error === 'otp_required')) {
      return toast('Withdrawal failed', apiMessage(e), 'bad');
    }
  }

  // The client has to agree. Send the code to THEM, then ask for it here.
  var bid = (STATE.book || []).find(function (b) { return String(b.id) === String(id); }) || {};
  try {
    var sent = await api('/bids/otp', { method: 'POST', body: {
      client_ucc: bid.client_ucc, issue_id: bid.issue_id, action: 'cancel', bid_id: id,
      detail: bid.ref } });
    var code = window.prompt(
      'A confirmation code has been sent to ' + sent.sent_to + ' for ' + bid.client_ucc + '.\n\n' +
      'Enter the code the client received:' + (sent.test_code ? '\n\nTest mode code: ' + sent.test_code : ''));
    if (!code) return toast('Not withdrawn', 'No code entered, so the bid is unchanged.', 'warn');

    body.otp_ref = sent.ref;
    body.otp = String(code).replace(/\D/g, '');
    await api('/bids/' + id, { method: 'DELETE', body: body });
    toast('Bid withdrawn', bid.ref + ' — confirmed by the client.', 'ok');
    loadBook(); loadDash();
  } catch (e2) { toast('Withdrawal failed', apiMessage(e2), 'bad'); }
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
    exchange: $('#pbExch').value || null,
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

/* ------------------------------------------------------------- bid form rules --
 * Everything here mirrors a rule the server also enforces. The server is what
 * decides; this exists so the desk is not told at 15:14 something it could have
 * been told at 15:09.
 */

/** Cut-off is a RETAIL mechanism. SEBI's non-retail leg is a price bid, always. */
function cutoffAllowed(issue, category) {
  if (category !== 'Retail') return false;
  return !issue || issue.cutoff_flag !== false;
}

/** The floor that applies to this category — Retail may have its own cut-off min. */
function minPriceFor(issue, category) {
  if (!issue) return null;
  var floor = issue.floor_price == null || issue.floor_price === '' ? null : Number(issue.floor_price);
  if (category === 'Retail') {
    var cm = issue.cut_price_min == null || issue.cut_price_min === '' ? null : Number(issue.cut_price_min);
    if (cm != null && cm > 0) return cm;
  }
  return floor != null && floor > 0 ? floor : null;
}

/**
 * The smallest quantity worth submitting.
 *
 * Retail is bounded ABOVE by the SEBI cap, so its minimum is just one lot. HNI is
 * bounded BELOW — a non-institutional bid must be at least hni_min in value — so
 * its minimum quantity is whatever clears that at the price being bid, rounded UP
 * to the lot. Rounding down would produce a number the exchange rejects.
 */
function minQtyFor(issue, category, price, cfg) {
  var lot = Number(issue && issue.lot) || 1;
  if (category !== 'HNI') return lot;
  var p = Number(price) || minPriceFor(issue, category);
  var floorValue = Number((cfg || {}).hni_min || 200000);
  if (!p || !floorValue) return lot;
  return Math.max(lot, Math.ceil(Math.ceil(floorValue / p) / lot) * lot);
}

/** The largest retail quantity that still fits under the SEBI cap at this price. */
function maxRetailQty(issue, price, cfg) {
  var lot = Number(issue && issue.lot) || 1;
  var p = Number(price) || minPriceFor(issue, 'Retail');
  var cap = Number((cfg || {}).retail_cap || 200000);
  if (!p) return null;
  return Math.max(0, Math.floor(Math.floor(cap / p) / lot) * lot);
}

/**
 * A suggested bid, which is what "default" means here.
 *
 *   Retail  bids at the TOP of what the cap allows — the highest price improves the
 *           chance of allotment, and the quantity is then whatever still fits.
 *   HNI     bids at the floor, the MINIMUM price, and the smallest quantity that
 *           clears the non-retail minimum.
 *
 * Both are starting points a desk is expected to change, not instructions.
 */
function suggestedBid(issue, category, cfg) {
  var mp = minPriceFor(issue, category);
  if (!issue || mp == null) return null;
  var tick = Number(issue.tick) || 0.05;
  if (category === 'HNI') {
    var price = mp;
    return { price: price, qty: minQtyFor(issue, 'HNI', price, cfg),
             why: 'HNI: the minimum price, and the smallest quantity that clears the non-retail minimum.' };
  }
  // Retail: the cap is on VALUE, so a higher price buys fewer shares. Bid at the
  // floor plus nothing — the floor IS the best price for fitting under the cap —
  // unless an indicative price is known.
  var rp = Math.round(mp / tick) * tick;
  return { price: Number(rp.toFixed(2)), qty: maxRetailQty(issue, rp, cfg),
           why: 'Retail: the lowest allowed price, and the largest quantity that still fits under the ' +
                rupee(Number((cfg || {}).retail_cap || 200000), 0) + ' cap.' };
}

/** Recompute everything derived from the current form state. */
function refreshBidForm() {
  var i = selectedIssue();
  var cat = $('#pbCat').value;
  var cfg = STATE.settings || {};

  /*
   * Which exchange this bid goes to.
   *
   * A bid reaches exactly ONE exchange. Where the issue is on one, there is nothing
   * to choose and the field says so; where it is on BOTH, somebody must choose,
   * because otherwise the NSE file and the BSE file would each carry this bid and
   * the client would be submitted twice.
   */
  var ex = $('#pbExch');
  var on = String((i && i.exchange) || '').toUpperCase();
  var wantedEx = ex.value;
  if (on === 'NSE' || on === 'BSE') {
    ex.innerHTML = '<option value="' + on + '">' + on + '</option>';
    ex.value = on;
    ex.disabled = true;
    $('#pbExchHint').textContent = i.symbol + ' is offered on ' + on + ' only.';
  } else if (on === 'BOTH') {
    ex.innerHTML = '<option value="">Choose…</option><option value="NSE">NSE</option><option value="BSE">BSE</option>';
    ex.value = wantedEx === 'NSE' || wantedEx === 'BSE' ? wantedEx : '';
    ex.disabled = false;
    $('#pbExchHint').textContent = 'On both exchanges — this bid goes to one of them, and only that file will carry it.';
  } else {
    ex.innerHTML = '<option value="">—</option>';
    ex.disabled = true;
    $('#pbExchHint').textContent = '';
  }

  var typeSel = $('#pbType');
  var allowed = cutoffAllowed(i, cat);

  // Cut-off for HNI is not a choice the desk should be able to make and then be
  // refused for; remove it rather than reject it.
  var wanted = typeSel.value;
  typeSel.innerHTML = '<option value="price">Price bid</option>' +
    (allowed ? '<option value="cutoff">Cut-off price</option>' : '');
  typeSel.value = allowed && wanted === 'cutoff' ? 'cutoff' : 'price';
  $('#pbTypeHint').textContent = allowed
    ? 'A cut-off bid takes the price the offer is struck at.'
    : (cat === 'HNI' ? 'Cut-off is a retail mechanism — a non-retail bid must carry a price.'
                     : 'Cut-off bidding is switched off for this issue.');

  var isCut = typeSel.value === 'cutoff';
  $('#pbPrice').disabled = isCut;
  if (isCut) $('#pbPrice').value = '';

  var mp = minPriceFor(i, cat);
  $('#pbPriceHint').textContent = i
    ? (mp == null ? 'No floor published yet for this issue.'
                  : 'At or above ' + rupee(mp) + ', in steps of ' + inr(i.tick, 2) + '.')
    : '';

  var price = isCut ? mp : (Number($('#pbPrice').value) || 0);
  var minQ = i ? minQtyFor(i, cat, price, cfg) : 1;
  $('#pbQty').min = minQ;
  $('#pbQty').step = Number(i && i.lot) || 1;
  $('#pbQtyHint').textContent = !i ? ''
    : cat === 'HNI'
      ? 'At least ' + inr(minQ, 0) + ' at this price, in multiples of ' + inr(i.lot, 0) + '.'
      : 'Multiples of ' + inr(i.lot, 0) +
        (maxRetailQty(i, price, cfg) ? '. Up to ' + inr(maxRetailQty(i, price, cfg), 0) + ' under the retail cap.' : '');

  var sug = i ? suggestedBid(i, cat, cfg) : null;
  $('#pbDefaultHint').textContent = sug ? sug.why : '';
  $('#pbDefault').disabled = !sug;

  // The total, before anyone presses Validate. A cut-off bid with no published
  // floor has no value yet, and saying so is better than showing zero.
  var qty = Number($('#pbQty').value) || 0;
  var val = price && qty ? price * qty : null;
  $('#pbValue').value = val == null
    ? (isCut && mp == null ? 'Unknown until the floor is published' : '—')
    : rupee(val, 2);
}

/** Fill the form with the suggested bid for the current category. */
function fillSuggestedBid() {
  var i = selectedIssue();
  if (!i) return;
  var sug = suggestedBid(i, $('#pbCat').value, STATE.settings || {});
  if (!sug) { toast('No suggestion', 'This issue has no published floor to work from.', 'warn'); return; }
  $('#pbType').value = 'price';
  $('#pbPrice').disabled = false;
  $('#pbPrice').value = sug.price;
  $('#pbQty').value = sug.qty;
  refreshBidForm();
}

/**
 * Look the client up as soon as the UCC looks complete, rather than waiting for
 * Validate. Debounced, because this fires on every keystroke.
 */
var uccTimer = null;
function onUccTyped() {
  var v = $('#pbUcc').value.trim().toUpperCase();
  if (uccTimer) clearTimeout(uccTimer);
  if (v.length < 3) {
    $('#pbClient').className = 'note';
    $('#pbClient').textContent = 'Enter a UCC to see client, margin and limits.';
    return;
  }
  uccTimer = setTimeout(function () { loadClientPanel(v); }, 350);
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

/* ---------------------------------------------------- the client's confirmation --
 * Every bid the desk places is a bid on someone else's behalf, so the client
 * confirms it with a code sent to their own mobile and email. The server refuses
 * with 428 until the code comes back; this turns that refusal into a step rather
 * than an error.
 */
var OTP_STATE = null;     // { ref, action, sent_to }

function hideBidOtp() {
  OTP_STATE = null;
  var box = $('#pbOtp');
  box.classList.add('hide');
  box.innerHTML = '';
}

function showBidOtp(action) {
  var box = $('#pbOtp');
  box.classList.remove('hide');
  box.innerHTML =
    '<div class="note warn" style="margin-top:10px">' +
      '<b>The client must confirm this ' + esc(action === 'modify' ? 'change' : action) + '.</b><br>' +
      'A one-time code goes to the mobile and email registered for ' +
      esc($('#pbUcc').value.trim().toUpperCase()) + ' — not to you. Ask them for it.' +
      '<div class="bar" style="margin-top:10px">' +
        '<button class="btn ghost" id="pbOtpSend">Send code to client</button>' +
        '<input type="text" id="pbOtpCode" inputmode="numeric" maxlength="6" placeholder="6-digit code" ' +
          'style="width:150px" disabled>' +
        '<button class="btn" id="pbOtpGo" disabled>Confirm and ' +
          esc(action === 'cancel' ? 'withdraw' : action) + '</button>' +
      '</div>' +
      '<div id="pbOtpNote" class="fh"></div>' +
    '</div>';
  $('#pbOtpSend').addEventListener('click', function () { sendBidOtp(action); });
  $('#pbOtpGo').addEventListener('click', function () { placeBid(true); });
  $('#pbOtpCode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') placeBid(true);
  });
}

async function sendBidOtp(action) {
  var btn = $('#pbOtpSend');
  btn.disabled = true;
  try {
    var r = await api('/bids/otp', { method: 'POST', body: {
      client_ucc: $('#pbUcc').value.trim().toUpperCase(),
      issue_id: $('#pbIssue').value,
      action: action,
      bid_id: STATE.editing ? STATE.editing.id : null,
      detail: inr($('#pbQty').value, 0) + ' shares at ' +
              ($('#pbType').value === 'cutoff' ? 'cut-off' : rupee($('#pbPrice').value))
    } });
    OTP_STATE = { ref: r.ref, action: action, sent_to: r.sent_to };
    $('#pbOtpCode').disabled = false;
    $('#pbOtpGo').disabled = false;
    $('#pbOtpCode').focus();
    $('#pbOtpNote').innerHTML = 'Sent to ' + esc(r.sent_to) + ' · valid ' + r.ttl_minutes + ' minutes.' +
      (r.test_code ? ' <b>Test mode: ' + esc(r.test_code) + '</b>' : '');
  } catch (e) {
    $('#pbOtpNote').textContent = apiMessage(e);
    toast('Could not send the code', apiMessage(e), 'bad');
  } finally { btn.disabled = false; }
}

async function placeBid(withOtp) {
  var editing = STATE.editing;
  var body = bidPayload();
  if (withOtp && OTP_STATE) {
    body.otp_ref = OTP_STATE.ref;
    body.otp = $('#pbOtpCode').value.replace(/\D/g, '');
    if (body.otp.length < 6) { $('#pbOtpNote').textContent = 'Enter the 6-digit code.'; return; }
  }
  try {
    var r = editing
      ? await api('/bids/' + editing.id, { method: 'PUT', body: body })
      : await api('/bids', { method: 'POST', body: body });
    hideBidOtp();
    toast(editing ? 'Bid modified' : 'Bid placed',
      r.bid.ref + ' · ' + inr(r.bid.qty, 0) + ' shares · ' + rupee(r.bid.value, 0), 'ok');
    $('#pbPlace').disabled = true;
    $('#pbQty').value = ''; $('#pbPrice').value = '';
    refreshBidForm();
    if (editing) { endModify(); showTab('book'); }
    loadDash();
  } catch (e) {
    if (e.status === 428 && e.body && e.body.error === 'otp_required') {
      showBidOtp(e.body.action || (editing ? 'modify' : 'place'));
      return;
    }
    if (OTP_STATE && e.status === 401) {
      // A wrong or stale code: keep the step open so it can be retyped.
      $('#pbOtpNote').textContent = apiMessage(e);
      if (e.body && e.body.error !== 'wrong') { OTP_STATE = null; $('#pbOtpGo').disabled = true; }
      return;
    }
    var msg = e.body && e.body.errors ? e.body.errors.join(' ') : apiMessage(e);
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
  renderIssueInfo();
  refreshBidForm();
  // After refreshBidForm has rebuilt the options, or the bid's own exchange would be
  // overwritten by whatever the list defaulted to.
  if (bid.exchange) $('#pbExch').value = bid.exchange;
  loadClientPanel(bid.client_ucc);
  loadExistingBids();
}

/**
 * Open Place bid on this issue, filled in and ready.
 *
 * Reached from an issue card on the dashboard: the desk's actual sequence is "this
 * one is open — bid on it", and making them change tab and find it again in a
 * dropdown is a step that exists only because the screens were built separately.
 */
function bidOnIssue(id) {
  endModify();
  showTab('place');
  var pb = $('#pbIssue');
  if (pb) {
    pb.value = String(id);
    if (pb.value !== String(id)) {
      // Not in the list: it is closed, suspended, or needs review. Say which rather
      // than silently landing on a different issue.
      var i = (STATE.issues || []).filter(function (x) { return String(x.id) === String(id); })[0];
      toast('Not open for bidding', i
        ? i.symbol + ' is ' + (i.status_label || 'not open') + '.'
        : 'That issue is not in the current list.', 'warn');
      return;
    }
  }
  renderIssueInfo();
  refreshBidForm();
  // Retail if its window is the one open, otherwise HNI — the category that can
  // actually be bid right now.
  var iss = selectedIssue();
  if (iss) $('#pbCat').value = iss.ret_status === 'Open' ? 'Retail'
                             : iss.hni_status === 'Open' ? 'HNI' : $('#pbCat').value;
  refreshBidForm();
  fillSuggestedBid();
  loadExistingBids();
  $('#pbUcc').focus();
}

/**
 * The bids already on the selected issue — for this client if one is named, for the
 * whole issue otherwise.
 *
 * This screen used to refuse a second bid with "a live bid already exists" while
 * showing nothing about the bid it meant, which left the desk to go and find it in
 * the book. Now it is on the same screen, with Modify and Withdraw on it.
 */
async function loadExistingBids() {
  var box = $('#pbExisting');
  if (!box) return;
  var id = $('#pbIssue') && $('#pbIssue').value;
  if (!id) {
    box.className = 'note';
    box.textContent = 'Pick an issue to see the bids already on it.';
    return;
  }
  var ucc = $('#pbUcc').value.trim().toUpperCase();
  try {
    var d = await api('/bids?issue_id=' + encodeURIComponent(id) +
      (ucc.length >= 3 ? '&q=' + encodeURIComponent(ucc) : '') + '&include_cancelled=1');
    var rows = (d.bids || []).filter(function (b) {
      return !ucc || String(b.client_ucc).toUpperCase() === ucc;
    });
    box.className = '';
    if (!rows.length) {
      box.className = 'note';
      box.textContent = ucc
        ? 'No bid yet for ' + ucc + ' on this issue.'
        : 'No bids on this issue yet.';
      return;
    }
    box.innerHTML =
      '<div class="legend">' + rows.length + ' bid(s)' + (ucc ? ' for ' + esc(ucc) : ' on this issue') + '</div>' +
      '<div class="wrap"><table><thead><tr><th>Ref</th><th>UCC</th><th>Exch</th><th>Cat</th>' +
      '<th class="n">Qty</th><th class="n">Price</th><th class="n">Value</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows.map(function (b) {
        return '<tr><td class="m">' + esc(b.ref) + '</td>' +
          '<td class="m">' + esc(b.client_ucc) + '</td>' +
          '<td>' + esc(b.exchange || '—') + '</td>' +
          '<td><span class="tag ' + (b.category === 'Retail' ? 'ret' : 'hni') + '">' + esc(b.category) + '</span></td>' +
          '<td class="n">' + inr(b.qty, 0) + '</td>' +
          '<td class="n">' + (b.is_cutoff ? 'Cut-off' : inr(b.price, 2)) + '</td>' +
          '<td class="n">' + inr(b.value, 0) + '</td>' +
          '<td><span class="st ' + statusCls(b.status) + '">' + esc(b.status) + '</span></td>' +
          '<td>' + (b.status === 'Cancelled' ? '' :
            '<button class="mini" data-edit="' + b.id + '">Modify</button> ' +
            '<button class="mini" data-cancel="' + b.id + '">Withdraw</button>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    // The book is what startModify reads from, so it must hold these rows too.
    STATE.book = (STATE.book || []).filter(function (x) {
      return !rows.some(function (r) { return String(r.id) === String(x.id); });
    }).concat(rows);
  } catch (e) {
    box.className = 'note bad';
    box.textContent = apiMessage(e);
  }
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
      (d.has_header_row === false
        ? '<span class="tag" title="The file itself carries no column names — the exchange reads line 1 as a bid. Column names below are shown for checking only.">no header row (by spec)</span>'
        : '<span class="tag" title="Line 1 of the file is a header row.">header row included</span>') +
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

    // The preview used to take line 1 as the column names. NSE's file has a header
    // row so that looked right; BSE's has none by design, so the first BID was being
    // drawn as the header and never shown as a row — two bids in, one bid displayed.
    //
    // The column names come from the adapter (d.header) either way, which is what
    // they were always for; only the file itself decides whether line 1 is data.
    var body = d.has_header_row === false ? lines : lines.slice(1);
    var head = (d.header && d.header.length)
      ? d.header
      : csvParse(lines[0])[0] || [];

    // Screen-only columns, marked as such. They come from d.meta, not from the file
    // — an exchange file carries the documented fields and nothing else, and one
    // extra column is a rejected upload. So the desk can see who placed each bid and
    // when without any of it reaching NSE or BSE.
    var meta = d.meta || [];
    var extra = meta.length ? ['Ref', 'Placed by', 'Placed at (IST)', 'Last changed (IST)'] : [];

    $('#exTbl').innerHTML =
      '<thead><tr><th class="n">#</th>' +
        head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
        extra.map(function (h, ix) {
          return '<th class="off-file' + (ix === 0 ? ' off-file-first' : '') + '">' + esc(h) + '</th>';
        }).join('') +
      '</tr></thead><tbody>' +
      body.map(function (l, ix) {
        // csvParse, not split(','), so a quoted field containing a comma stays one cell.
        var cells = csvParse(l)[0] || [];
        var m = meta[ix] || {};
        var who = m.placed_by === 'desk' ? (m.actor || 'back office')
                : m.placed_by === 'ap' ? 'AP ' + (m.actor || '')
                : m.placed_by === 'client' ? 'client'
                : (m.placed_by || '');
        var off = meta.length ? [m.ref, who, m.placed_at, m.changed_at] : [];
        return '<tr><td class="n">' + (ix + 1) + '</td>' +
          cells.map(function (v) {
            return '<td class="m">' + (v === '' ? '<span class="dash">—</span>' : esc(v)) + '</td>';
          }).join('') +
          off.map(function (v, j) {
            return '<td class="m off-file' + (j === 0 ? ' off-file-first' : '') + '">' +
              (v ? esc(v) : '<span class="dash">—</span>') + '</td>';
          }).join('') + '</tr>';
      }).join('') + '</tbody>' +
      (meta.length
        ? '<tfoot><tr><td colspan="' + (1 + head.length + extra.length) + '" class="off-file-note">' +
          'The four shaded columns are shown here only. They are <b>not</b> written to the ' +
          'exchange file — NSE and BSE accept the documented fields and nothing else. ' +
          'Use <b>Download all (audit)</b> for a file that includes them.' +
          '</td></tr></tfoot>'
        : '');
  } catch (e) { toast('Preview failed', exportError(e), 'bad'); }
}

/**
 * "Failed to fetch" is what the browser says when the request never reached the
 * server — almost always a restart mid-request or a dropped connection. Saying that
 * is more useful than repeating the browser's wording, and the codes the export
 * route returns deserve sentences rather than identifiers.
 */
function exportError(e) {
  var code = (e.body && (e.body.error || e.body.code)) || e.code || '';
  if (code === 'no_rows') return 'There are no bids matching this selection, so there is nothing to put in a file.';
  if (code === 'isin_missing') return (e.body && e.body.message) || 'An issue in this selection has no confirmed ISIN yet.';
  if (e.status === 401) return 'Your session has ended. Reload the page and sign in again.';
  if (e.status === 403) return 'Your role does not allow generating exchange files.';
  if (/failed to fetch|networkerror|load failed/i.test(e.message || '')) {
    return 'The server did not respond — it may have just restarted. Reload the page and try again.';
  }
  return apiMessage(e) || 'Something went wrong.';
}

/**
 * The desk's own extract: every field, plus who placed each bid and when. Built
 * through the same export path as an exchange file so it is logged and audited the
 * same way, but it is not an exchange file and never goes to one.
 *
 * It ignores the exchange selector on purpose — there is one book, and which
 * exchange a file would be cut for does not change what happened.
 */
/**
 * The bid book on screen, as a file — every field, filters and all. Routed through
 * the same FULL export the Exchange files tab uses, so it is checksummed, logged and
 * audited rather than assembled in the browser from whatever happened to be drawn.
 */
async function downloadBookCsv() {
  var q = bookQuery();
  var url = '/api/export/FULL/download' + (q ? '?' + q : '');
  var btn = $('#bkCsv');
  btn.disabled = true;
  try {
    var res = await fetch(url, {
      headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}, credentials: 'same-origin' });
    if (!res.ok) {
      var j = await res.json().catch(function () { return {}; });
      var err = new Error(j.message || j.error || res.statusText);
      err.status = res.status; err.body = j; throw err;
    }
    var blob = await res.blob();
    var name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name ? name[1] : 'OFS_Bids.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('Downloaded', 'The bid book with these filters, all fields included.', 'ok');
  } catch (e) {
    toast('Download failed', exportError(e), 'bad');
  } finally { btn.disabled = false; }
}

async function downloadFullExport() {
  var url = '/api/export/FULL/download?' + exportQuery();
  var headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
  var btn = $('#exFull');
  btn.disabled = true;
  try {
    var res = await fetch(url, { headers: headers, credentials: 'same-origin' });
    if (!res.ok) {
      var j = await res.json().catch(function () { return {}; });
      var err = new Error(j.message || j.error || res.statusText);
      err.status = res.status; err.body = j;
      throw err;
    }
    var blob = await res.blob();
    var name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name ? name[1] : 'OFS_Bids_Full.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('Downloaded', 'Full bid extract, including who placed each bid and when.', 'ok');
    loadExportLog();
  } catch (e) {
    toast('Download failed', exportError(e), 'bad');
  } finally { btn.disabled = false; }
}

async function downloadExport(part) {
  var url = '/api/export/' + $('#exExch').value + '/download?' + exportQuery(part);
  var headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
  try {
    var res = await fetch(url, { headers: headers, credentials: 'same-origin' });
    if (!res.ok) {
      var j = await res.json().catch(function () { return {}; });
      var err = new Error(j.message || j.error || res.statusText);
      err.status = res.status; err.body = j;
      throw err;
    }
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
  } catch (e) { toast('Download failed', exportError(e), 'bad'); }
}

async function loadExportLog() {
  try {
    var d = await api('/export/log');
    var r = d.exports || [];
    pagedTable('exports', $('#exLogTbl'), r, function (page) {
      return '<thead><tr><th>Generated</th><th>Exchange</th><th>Symbol</th><th>File</th>' +
      '<th class="n">Rows</th><th class="n">Qty</th><th>Checksum</th><th>By</th></tr></thead><tbody>' +
      page.map(function (x) {
        return '<tr><td class="m">' + dt(x.generated_at) + '</td><td>' + esc(x.exchange) + '</td>' +
          '<td>' + esc(x.symbol || 'ALL') + '</td><td class="m">' + esc(x.file_name) + '</td>' +
          '<td class="n">' + inr(x.row_count, 0) + '</td><td class="n">' + inr(x.total_qty, 0) + '</td>' +
          '<td class="m">' + esc(String(x.checksum).slice(0, 16)) + '…</td><td>' + esc(x.generated_by || '') + '</td></tr>';
      }).join('') + '</tbody>';
    }, 'files', loadExportLog, 'No file generated yet.');
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
  if (t === 'circulars') { loadCirculars(); loadCircularRuns(); }
}
function loadMasters() { showMTab(STATE.mtab); }

/**
 * One bidding window in a table cell. Two stacked lines, not one long one: a
 * full dd-MMM-yyyy hh:mm AM stamp at each end is ~250px wide, and two of those
 * side by side are what pushed this table off the screen.
 */
function windowCell(open, close) {
  if (!open && !close) return '<span class="sub">—</span>';
  return '<div class="win m">' + esc(dt(open)) + '</div>' +
         '<div class="win m to">' + esc(dt(close)) + '</div>';
}

async function loadIssues() {
  try {
    var d = await api('/issues');
    var r = d.issues || [];
    STATE.issueRows = r;
    pagedTable('issues', $('#issueTbl'), r, function (page) {
      // Fourteen columns did not fit any screen, so the table scrolled sideways
      // and took the expanded row with it. The terms nobody scans row by row —
      // ISIN, tick, lot, discount, cut-off minimum — now sit stacked under the
      // figure they belong to, and the whole row fits without a scrollbar.
      return '<thead><tr><th>Scrip</th><th>Exch</th><th class="n">Floor</th>' +
      '<th>HNI window</th><th>Retail window</th><th class="n">Terms</th>' +
      '<th>Docs</th><th>Status</th><th></th></tr></thead><tbody>' +
      page.map(function (i) {
        return '<tr><td><b>' + esc(i.symbol) + '</b>' +
            '<div class="sub">' + esc(i.company || '—') + '</div>' +
            '<div class="sub m">' + esc(i.isin || 'ISIN pending') + '</div></td>' +
          '<td><span class="tag">' + esc(i.exchange) + '</span></td>' +
          // An undisclosed floor is a blank, not a zero — see migration 014.
          '<td class="n">' + (i.floor_price == null ? '—' : inr(i.floor_price)) +
            '<div class="sub">cut-off ' +
            (i.cut_price_min == null ? '—' : inr(i.cut_price_min)) + '</div></td>' +
          '<td>' + windowCell(i.hni_open, i.hni_close) + '</td>' +
          '<td>' + windowCell(i.ret_open, i.ret_close) + '</td>' +
          '<td class="n">' + inr(i.discount_pct, 2) + '%' +
            '<div class="sub">tick ' + inr(i.tick) + ' · lot ' + inr(i.lot, 0) + '</div></td>' +
          // No paperwork is worth saying out loud: the circular is what justifies
          // this issue's floor price and windows to anyone reading it later.
          '<td>' + (Number(i.doc_count) > 0
            ? '<span class="chip open" title="Open the row to read them">' + inr(i.doc_count, 0) + ' attached</span>'
            : '<span class="chip soon" title="Open the row to attach the circular or notice">none</span>') + '</td>' +
          '<td><span class="chip ' + chipCls(i.status_label) + '">' + esc(i.status_label) + '</span>' +
            (i.needs_review
              ? '<div class="sub" title="' + esc(i.review_note || '') + '">needs review</div>' : '') + '</td>' +
          // Open is what reaches the documents — the circular, the member notice, the
          // PDF. It was wired on the Archive table only, so for a LIVE issue, which
          // is the one that actually needs its circular attached, there was no way
          // in from this screen at all.
          '<td class="act"><button class="mini" data-detail="' + i.id + '">Open</button> ' +
            '<button class="mini" data-grant="ofs-masters" data-issedit="' + i.id + '">Edit</button></td></tr>';
      }).join('') + '</tbody>';
    }, 'issues', loadIssues, 'No issue in the master yet.');
  } catch (e) { toast('Issues failed', e.message, 'bad'); }
}

function fld(id, label, type, val, hint) {
  return '<label class="f"><span class="k">' + esc(label) + '</span>' +
    '<input id="' + id + '" type="' + type + '" step="any" style="width:100%" value="' +
    esc(val == null ? '' : val) + '">' +
    (hint ? '<span class="fh">' + esc(hint) + '</span>' : '') + '</label>';
}
/** opts is a list of strings, or of [value, label] pairs when the two differ. */
function fldSel(id, label, opts, val, hint) {
  return '<label class="f"><span class="k">' + esc(label) + '</span><select id="' + id + '" style="width:100%">' +
    opts.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, t = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' +
        esc(t) + '</option>';
    }).join('') + '</select>' +
    (hint ? '<span class="fh">' + esc(hint) + '</span>' : '') + '</label>';
}

/**
 * A timestamptz from the API into what <input type="datetime-local"> accepts.
 * Local (IST) wall-clock, no timezone suffix — the same convention the form uses
 * when it sends a value back, so a saved window does not shift by 5.5 hours.
 */
function dtLocal(v) {
  if (!v) return '';
  var d = new Date(v);
  if (isNaN(d)) return '';
  var p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * Add or edit one issue. Every column the API accepts is on this form — the CSV
 * template carried discount_pct, cutoff_flag, series and bse_scrip_code while the
 * manual form did not, so an issue typed in by hand silently took the defaults and
 * the BSE scrip code had no way in at all.
 *
 * Pass an issue to edit it; omit for a new one.
 */
function issueForm(issue) {
  var i = issue || {};
  var editing = !!i.id;
  var f = $('#miForm');
  f.classList.remove('hide');
  f.innerHTML =
    '<div class="card">' +
    (editing ? '<div class="bar"><b>Editing ' + esc(i.symbol) + '</b>' +
       '<span class="tag">#' + esc(i.id) + '</span></div>' : '') +
    '<div class="grid2">' +
      fld('fSymbol', 'Symbol', 'text', i.symbol) + fld('fCompany', 'Company', 'text', i.company) +
      fld('fIsin', 'ISIN', 'text', i.isin) +
      fldSel('fExch', 'Exchange', ['NSE', 'BSE', 'BOTH'], i.exchange || 'NSE') +
      fld('fSeries', 'Series', 'text', i.series || 'EQ') +
      fld('fBseCode', 'BSE scrip code', 'text', i.bse_scrip_code,
          'Needed for the BSE file. No feed exists for it.') +
      fld('fFloor', 'Floor price', 'number', i.floor_price,
          'Leave blank if the seller has not published one.') +
      fld('fCut', 'Retail cut-off min', 'number', i.cut_price_min) +
      fld('fTick', 'Tick', 'number', i.tick == null ? '0.05' : i.tick) +
      fld('fLot', 'Lot', 'number', i.lot == null ? '1' : i.lot) +
      fld('fIssueQty', 'Issue qty (for subscription)', 'number', i.issue_qty) +
      fld('fRetQty', 'Retail reserved qty', 'number', i.retail_qty) +
      fld('fDiscount', 'Retail discount %', 'number', i.discount_pct == null ? '0' : i.discount_pct,
          'Discount to retail on the cut-off price.') +
      fldSel('fCutoffFlag', 'Cut-off bidding', [['1', 'Allowed for Retail'], ['0', 'Not allowed']],
          i.cutoff_flag === false ? '0' : '1') +
      fld('fHniOpen', 'HNI open', 'datetime-local', dtLocal(i.hni_open)) +
      fld('fHniClose', 'HNI close', 'datetime-local', dtLocal(i.hni_close)) +
      fld('fRetOpen', 'Retail open', 'datetime-local', dtLocal(i.ret_open)) +
      fld('fRetClose', 'Retail close', 'datetime-local', dtLocal(i.ret_close)) +
      (editing ? fldSel('fStatus', 'Status', ['Auto', 'Suspended', 'Closed'], i.status || 'Auto',
          'Suspended and Closed both hide it from clients.') : '') +
    '</div><div class="bar" style="margin-top:12px">' +
      '<button class="btn" id="miSave">' + (editing ? 'Save changes' : 'Save issue') + '</button>' +
      '<button class="btn ghost" id="miCancel">Cancel</button></div></div>';
  $('#miSave').addEventListener('click', function () { saveIssue(i.id || null); });
  $('#miCancel').addEventListener('click', function () { f.classList.add('hide'); f.innerHTML = ''; });
  f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Open the form on an existing issue, loaded fresh so it is never a stale row. */
async function editIssue(id) {
  try {
    var d = await api('/issues/' + id);
    showMTab('issues');
    issueForm(d.issue);
  } catch (e) { toast('Could not open', apiMessage(e), 'bad'); }
}

async function saveIssue(editingId) {
  markFields([]);                       // clear whatever the last attempt flagged
  var num = function (sel) { return $(sel).value === '' ? null : Number($(sel).value); };
  var body = {
    symbol: $('#fSymbol').value.trim().toUpperCase(),
    company: $('#fCompany').value.trim(),
    isin: $('#fIsin').value.trim().toUpperCase(),
    exchange: $('#fExch').value,
    series: $('#fSeries').value.trim().toUpperCase() || 'EQ',
    bse_scrip_code: $('#fBseCode').value.trim() || null,
    // Blank floor is legitimate: NSE's own FAQ (Q12) says the seller need not
    // publish one. Sending 0 instead would be inventing a price.
    floor_price: num('#fFloor'),
    cut_price_min: num('#fCut'),
    tick: num('#fTick') || 0.05,
    lot: num('#fLot') || 1,
    issue_qty: num('#fIssueQty'),
    retail_qty: num('#fRetQty'),
    discount_pct: num('#fDiscount') || 0,
    cutoff_flag: $('#fCutoffFlag').value === '1',
    hni_open: $('#fHniOpen').value, hni_close: $('#fHniClose').value,
    ret_open: $('#fRetOpen').value, ret_close: $('#fRetClose').value
  };
  if ($('#fStatus')) body.status = $('#fStatus').value;

  try {
    if (editingId) {
      await api('/issues/' + editingId, { method: 'PUT', body: body });
      toast('Issue updated', body.symbol + ' has been changed.', 'ok');
      $('#miForm').classList.add('hide');
      $('#miForm').innerHTML = '';
      loadIssues(); loadDash();
      return;
    }
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
  } catch (e) {
    var b = e.body || {};
    markFields(b.fields || (b.field ? [b.field] : []));
    toast(editingId ? 'Not saved' : 'Issue not added', apiMessage(e), 'bad');
  }
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
    toast('Could not start the pull', apiMessage(e), 'bad');
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

    // Say plainly what each exchange can do. Pressing "Pull now" and reading a
    // failure log is a poor way to learn that NSE needs credentials.
    var cap = st.capability || {};
    var box = $('#syCapability');
    if (box) {
      box.innerHTML = Object.keys(cap).map(function (k) {
        var c = cap[k];
        return '<div class="note ' + (c.level === 'api' ? 'good' : 'warn') + '">' +
          '<b>' + esc(k) + ' — ' + esc(c.label) + '.</b> ' + esc(c.detail) + '</div>';
      }).join('');
    }

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
  } catch (e) { toast('Could not save', apiMessage(e), 'bad'); }
}

async function loadSyncRuns() {
  try {
    var d = await api('/issues/sync/runs?limit=15');
    var r = d.runs || [];
    pagedTable('pulls', $('#syRunTbl'), r, function (page) {
      return '<thead><tr><th>#</th><th>Started</th><th>By</th><th>From</th><th>Status</th>' +
      '<th class="n">Found</th><th class="n">New</th><th class="n">Updated</th><th>Note</th></tr></thead><tbody>' +
      page.map(function (x) {
        return '<tr><td class="m">' + x.id + '</td><td class="m">' + dt(x.started_at) + '</td>' +
          '<td>' + esc(x.trigger === 'schedule' ? 'schedule' : (x.actor || 'desk')) + '</td>' +
          '<td>' + esc((x.exchanges || []).join(', ')) + '</td>' +
          '<td><span class="chip ' + (x.status === 'ok' ? 'open' : x.status === 'running' ? 'soon' : x.status === 'partial' ? 'soon' : 'closed') + '">' +
          esc(x.status) + '</span></td>' +
          '<td class="n">' + (x.found || 0) + '</td><td class="n">' + (x.inserted || 0) + '</td>' +
          '<td class="n">' + (x.updated || 0) + '</td>' +
          '<td class="sm">' + esc(x.error || '') + '</td></tr>';
      }).join('') + '</tbody>';
    }, 'pulls', loadSyncRuns, 'No pull has run yet.');
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
/**
 * Whether the watch is actually working, said plainly.
 *
 * The failure that matters is NSE refusing this server — a 403 from a datacentre
 * IP looks identical to "no OFS today" if all the desk sees is a timestamp. So the
 * status code and the error are shown, with what to do about each.
 */
function renderFeedHealth(st, f) {
  var el = $('#cirFeed');
  var box = $('#cirHealth');
  el.className = 'tag';

  if (!st.enabled) {
    el.textContent = 'Watch is off';
    if (box) { box.innerHTML = '<div class="note warn">The circular watch is switched off. ' +
      'Turn it on under <b>Masters → Settings → Watch NSE circulars</b>, or press ' +
      '<b>Check NSE now</b> for a one-off look.</div>'; }
    return;
  }

  var ok = f && f.last_ok_at;
  var code = f && f.last_status;
  var err = f && f.last_error;

  el.textContent = !f ? 'Not checked yet'
    : err ? 'NSE check failed'
    : ('NSE checked ' + dt(f.last_ok_at) + (code === 304 ? ' · unchanged' : ''));
  el.className = 'tag ' + (err ? 'hni' : ok ? 'ret' : '');

  if (!box) return;

  var bits = [];
  if (err) {
    // The two failures worth telling apart, because the fix is different.
    var blocked = code === 403 || code === 401;
    var down = code === 0;
    bits.push('<div class="note bad"><b>NSE is not answering this server.</b><br>' +
      esc(err) + (code ? ' (HTTP ' + code + ')' : '') + '<br><br>' +
      (blocked
        ? 'A 403 from a server IP usually means NSE is refusing datacentre clients. ' +
          'The feed is public, so this is a blocking rule rather than a permission problem — ' +
          'raise it with NSE Member Service Department, and meanwhile load issues from the ' +
          'T-2/T-1 member notice under <b>Masters → Import issues CSV</b>.'
        : down
          ? 'Nothing answered at all — check that the server has outbound HTTPS to ' +
            'nsearchives.nseindia.com.'
          : 'Press <b>Check NSE now</b> to retry. If it keeps failing, the feed URL may have moved.') +
      '</div>');
  } else if (!f) {
    bits.push('<div class="note">The feed has not been checked yet. Press <b>Check NSE now</b>, ' +
      'or wait for the scheduled check.</div>');
  } else if (!Number(st.counts && st.counts.ofs)) {
    bits.push('<div class="note good"><b>The watch is working.</b> ' +
      'NSE answered' + (f.items_seen ? ' with ' + f.items_seen + ' circular(s) seen so far' : '') +
      ', and none of them is an Offer for Sale. That is the normal state between issues — ' +
      'nothing is wrong.</div>');
  }

  bits.push('<div class="bar" style="margin:0">' +
    '<span class="tag">Every ' + st.poll_minutes + ' min</span>' +
    (st.alert_email
      ? '<span class="tag ret">Alerts to ' + esc(st.alert_email) + '</span>'
      : '<span class="tag hni">No email alert set</span>') +
    '<span class="tag">' + (Number(st.counts && st.counts.ofs) || 0) + ' OFS circular(s) recorded</span>' +
    '<span class="tag">' + (Number(st.counts && st.counts.imported) || 0) + ' set up</span>' +
    '</div>');

  box.innerHTML = bits.join('');
}

async function loadCirculars() {
  try {
    var st = $('#cirStatus').value;
    var d = await api('/circulars' + (st ? '?status=' + encodeURIComponent(st) : ''));
    var r = d.circulars || [];
    var f = (d.status && d.status.feed) || {};

    // The feed's health, in words. A stale timestamp with no reason is the worst
    // possible state to leave a desk in: it looks like "nothing is happening"
    // when it may mean "NSE has been refusing us for two days".
    renderFeedHealth(d.status, f);

    $('#cirEvery').value = String(d.status.poll_minutes);
    if (!$('#cirEvery').value) $('#cirEvery').value = '15';
    $('#cirAuto').value = d.status.autocreate ? '1' : '0';

    var unread = Number(d.status.counts && d.status.counts.unreviewed) || 0;
    var badge = $('#cirBadge');
    badge.textContent = unread;
    badge.classList.toggle('hide', !unread);

    pagedTable('circulars', $('#cirTbl'), r, function (page) {
      return '<thead><tr><th>Published</th><th>Company</th><th>Circular</th><th>Dept</th>' +
      '<th>Match</th><th>Status</th><th></th></tr></thead><tbody>' +
      page.map(function (c) {
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
      }).join('') + '</tbody>';
    }, 'circulars', loadCirculars, '(st === \'new\' ? \'Nothing waiting — no unreviewed OFS circular.\' : \'No circular recorded yet. Press “Check NSE now”.\') + \'');
  } catch (e) { toast('Circulars failed', e.message, 'bad'); }
}

/**
 * Show the check happening, step by step.
 *
 * A button that says "Checking…" and then goes quiet is the worst outcome: it looks
 * identical whether NSE answered with nothing, refused us, or the server has no
 * route to the internet at all. Each step is rendered as it is reported, so the
 * failure has an address.
 */
function renderCirSteps(steps, title, pct) {
  var box = $('#cirProgress');
  box.classList.remove('hide');
  $('#cirProgTitle').textContent = title;
  $('#cirProgPct').textContent = (pct == null ? '' : pct + '%');
  $('#cirProgFill').style.width = (pct == null ? 100 : pct) + '%';
  $('#cirLog').innerHTML = (steps || []).map(function (st) {
    return '<div><span class="ex">' + esc(st.phase || '') + '</span>' +
      '<span class="ms">' + esc(st.message || '') + '</span>' +
      '<span class="out ' + outClass(st.outcome) + '">' + esc(st.outcome || '') + '</span></div>';
  }).join('');
  var log = $('#cirLog'); log.scrollTop = log.scrollHeight;
}

/** Save the interval or the auto-create switch straight from the Circulars bar. */
async function saveCircularSetting(key, value, what) {
  try {
    await api('/settings', { method: 'PUT', body: { key: key, value: String(value) } });
    toast('Saved', what, 'ok');
    loadCirculars();
  } catch (e) { toast('Could not save', apiMessage(e), 'bad'); }
}

/**
 * Every check, and the totals across them.
 *
 * The state row only ever holds the LAST result, so without this "has NSE been
 * refusing us all week or did it fail once at 3am?" is unanswerable — and those two
 * need very different responses.
 */
async function loadCircularRuns() {
  try {
    var d = await api('/circulars/runs?limit=200');
    var r = d.runs || [];
    var sm = d.summary || {};

    $('#cirRunSummary').innerHTML = Number(sm.checks)
      ? '<div class="bar" style="margin:0 0 10px">' +
          '<span class="tag">' + (sm.checks || 0) + ' check(s)</span>' +
          '<span class="tag ' + (Number(sm.failed) ? 'hni' : 'ret') + '">' +
            (sm.failed || 0) + ' failed</span>' +
          '<span class="tag">' + (sm.unchanged || 0) + ' unchanged (304)</span>' +
          '<span class="tag">' + (sm.circulars_found || 0) + ' circular(s) found</span>' +
          '<span class="tag">' + (sm.issues_created || 0) + ' issue(s) created</span>' +
          (sm.avg_ms ? '<span class="tag">' + sm.avg_ms + ' ms average</span>' : '') +
          (sm.first_at ? '<span class="tag">since ' + dt(sm.first_at) + '</span>' : '') +
        '</div>'
      : '';

    pagedTable('cirruns', $('#cirRunTbl'), r, function (page) {
      return '<thead><tr><th>When</th><th>By</th><th>Result</th><th class="n">HTTP</th>' +
        '<th class="n">Took</th><th class="n">In feed</th><th class="n">Matched</th>' +
        '<th class="n">New</th><th class="n">Issues</th><th>Note</th></tr></thead><tbody>' +
        page.map(function (x) {
          var cls = x.status === 'ok' ? 'open' : x.status === 'unchanged' ? 'grey' : 'closed';
          return '<tr><td class="m">' + dt(x.started_at) + '</td>' +
            '<td>' + esc(x.trigger === 'schedule' ? 'schedule' : (x.actor || 'desk')) + '</td>' +
            '<td><span class="chip ' + cls + '">' + esc(x.status) + '</span></td>' +
            '<td class="n">' + (x.http_status || '—') + '</td>' +
            '<td class="n">' + (x.duration_ms == null ? '—' : x.duration_ms + ' ms') + '</td>' +
            '<td class="n">' + (x.items || 0) + '</td>' +
            '<td class="n">' + (x.matched || 0) + '</td>' +
            '<td class="n">' + (x.inserted || 0) + '</td>' +
            '<td class="n">' + (x.issues_made || 0) + '</td>' +
            '<td class="sm">' + esc(x.error || '') + '</td></tr>';
        }).join('') + '</tbody>';
    }, 'checks', loadCircularRuns, 'No check has run yet.');
  } catch (e) { toast('Check history failed', e.message, 'bad'); }
}

async function pollCirculars() {
  var b = $('#cirPoll');
  b.disabled = true; b.textContent = 'Checking…';

  renderCirSteps([{ phase: 'start', outcome: 'started',
    message: 'Asking the server to check the NSE circular feed…' }], 'Checking NSE…', 15);

  // The server gives up on NSE after 20s; give the request 30 so a hung connection
  // ends in a message rather than a button stuck on "Checking…" forever.
  var ctl = new AbortController();
  var killed = setTimeout(function () { ctl.abort(); }, 30000);

  try {
    var res = await fetch('/api/circulars/poll', {
      method: 'POST', credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
      signal: ctl.signal
    });
    var r = {};
    try { r = await res.json(); } catch (e0) {}

    if (!res.ok) {
      renderCirSteps((r.steps || []).concat([{ phase: 'server', outcome: 'failed',
        message: r.message || r.error || ('The server answered HTTP ' + res.status) }]),
        'Check failed', 100);
      toast('Check failed', r.message || r.error || ('HTTP ' + res.status), 'bad');
      return;
    }

    renderCirSteps(r.steps, r.error ? 'Check failed' : 'Check complete', 100);
    loadCircularRuns();
    toast(r.inserted ? r.inserted + ' new OFS circular(s)' : r.error ? 'Check failed' : 'Nothing new',
      r.notModified ? 'NSE reports the feed unchanged since the last check.'
        : r.error ? r.error
        : (r.items || 0) + ' circular(s) in the feed, ' + (r.matched || 0) + ' matched OFS.',
      r.error ? 'bad' : r.inserted ? 'ok' : 'warn');
    loadCirculars();
  } catch (e) {
    var msg = e.name === 'AbortError'
      ? 'The server did not answer within 30 seconds. It is most likely still waiting on NSE, '
        + 'which means outbound HTTPS from this server is blocked.'
      : /failed to fetch|networkerror|load failed/i.test(e.message || '')
        ? 'The browser could not reach the OFS server. Reload the page — it may have restarted.'
        : e.message;
    renderCirSteps([{ phase: 'browser', outcome: 'failed', message: msg }], 'Check failed', 100);
    toast('Check failed', msg, 'bad');
  } finally {
    clearTimeout(killed);
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
var AUDIT = { offset: 0, limit: PAGE_SIZE, total: 0, rows: [] };

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
  // Server-side paging here, not the client helper: the audit trail is the one list
  // that grows without limit, so the browser must never hold all of it.
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
    STATE.margins = r;
    pagedTable('margins', $('#marginTbl'), r, function (page) {
      return '<thead><tr><th>UCC</th><th>Client</th><th class="n">Available</th><th class="n">Used</th><th class="n">Free</th>' +
      '<th>Source</th><th>Updated</th><th>By</th><th></th></tr></thead><tbody>' +
      page.map(function (m) {
        return '<tr><td class="m">' + esc(m.client_ucc) + '</td>' +
          '<td>' + esc(m.client_name || '—') + '</td>' +
          '<td class="n">' + inr(m.available, 0) + '</td><td class="n">' + inr(m.used, 0) + '</td>' +
          '<td class="n' + (Number(m.free) < 0 ? ' neg' : '') + '">' + inr(m.free, 0) + '</td>' +
          '<td>' + esc(m.source) + '</td>' +
          '<td class="m">' + dt(m.updated_at) + '</td><td>' + esc(m.updated_by || '') + '</td>' +
          '<td><button class="mini" data-mgedit="' + esc(m.client_ucc) + '">Modify</button> ' +
              '<button class="mini" data-mgdel="' + esc(m.client_ucc) + '" data-grant="ofs-masters">Delete</button> ' +
              '<button class="mini" data-mglog="' + esc(m.client_ucc) + '">History</button></td></tr>';
      }).join('') + '</tbody>';
    }, 'clients', loadMargins, 'No margin snapshot loaded. RMS has no available-margin read API yet — set margins here or via CSV.');
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

/**
 * Show what is already committed against a client's margin as the UCC is typed.
 * One record per client, so this is also how "create" and "modify" differ: if a
 * figure is already there, the form is editing it.
 */
function showMarginFor(ucc) {
  var m = (STATE.margins || []).filter(function (x) { return x.client_ucc === ucc; })[0];
  $('#mgUsed').textContent = 'Used ' + (m ? rupee(m.used, 0) : '—');
  $('#mgFree').textContent = 'Free ' + (m ? rupee(m.free, 0) : '—');
  $('#mgSet').textContent = m ? 'Replace margin' : 'Save margin';
  return m;
}

/**
 * Confirm who the UCC belongs to BEFORE any margin can be saved.
 *
 * A margin typed against a mistyped UCC is not an error anyone sees: it creates a
 * record for a client who does not exist, or worse, funds the wrong one. So Save
 * stays disabled until the client has been fetched and named, and any edit to the
 * UCC disables it again.
 */
var MG_FETCHED = null;

function marginGate() {
  var ucc = $('#mgUcc').value.trim().toUpperCase();
  var ok = MG_FETCHED && MG_FETCHED.ucc === ucc;
  $('#mgSet').disabled = !ok;
  if (!ok) {
    $('#mgClient').textContent = ucc ? 'Fetch ' + ucc + ' first' : 'No client fetched';
    $('#mgClient').classList.remove('ok-tag');
  }
  showMarginFor(ucc);
}

async function fetchMarginClient() {
  var ucc = $('#mgUcc').value.trim().toUpperCase();
  if (!ucc) { toast('Enter a UCC', 'Type the client code first.', 'bad'); return; }
  var btn = $('#mgFetch');
  btn.disabled = true;
  try {
    var d = await api('/clients/' + encodeURIComponent(ucc));
    var c = d.client || {};
    MG_FETCHED = { ucc: ucc, name: c.name || '' , active: c.is_active !== false };
    $('#mgClient').textContent = (c.name || ucc) + (c.is_active === false ? ' · INACTIVE' : '');
    $('#mgClient').classList.toggle('ok-tag', c.is_active !== false);
    $('#mgClient').classList.toggle('warn-tag', c.is_active === false);
    $('#mgSet').disabled = false;
    showMarginFor(ucc);
    $('#mgAmt').focus();
  } catch (e) {
    MG_FETCHED = null;
    $('#mgSet').disabled = true;
    $('#mgClient').textContent = e.status === 404 ? 'No client found for ' + ucc : apiMessage(e);
    $('#mgClient').classList.add('warn-tag');
    $('#mgClient').classList.remove('ok-tag');
  } finally { btn.disabled = false; }
}

function editMargin(ucc) {
  $('#mgUcc').value = ucc;
  var m = showMarginFor(ucc);
  $('#mgAmt').value = m ? Number(m.available) : '';
  // Modifying an existing record still confirms who it is — the name in the list is
  // from the last fetch, and a client can be closed since.
  fetchMarginClient();
}

async function setMargin() {
  var ucc = $('#mgUcc').value.trim().toUpperCase(), amt = Number($('#mgAmt').value);
  if (!ucc || !isFinite(amt)) { toast('Missing input', 'Enter a UCC and an amount.', 'bad'); return; }
  var existing = (STATE.margins || []).filter(function (x) { return x.client_ucc === ucc; })[0];
  try {
    await api('/margin/' + encodeURIComponent(ucc), { method: 'PUT', body: { available: amt, source: 'manual' } });
    toast(existing ? 'Margin replaced' : 'Margin set',
      ucc + ' → ' + rupee(amt, 0) + (existing ? ' (was ' + rupee(existing.available, 0) + ')' : ''), 'ok');
    $('#mgAmt').value = ''; loadMargins();
  } catch (e) { toast('Failed', apiMessage(e), 'bad'); }
}

async function deleteMargin(ucc, force) {
  if (!force && !window.confirm('Remove the margin record for ' + ucc +
      '?\n\nThe history is kept — only the current figure goes.')) return;
  try {
    await api('/margin/' + encodeURIComponent(ucc), { method: 'DELETE', body: force ? { force: 'true' } : {} });
    toast('Margin removed', ucc + ' has no margin record now.', 'ok');
    loadMargins();
  } catch (e) {
    if (e.status === 409 && e.body && e.body.error === 'margin_in_use') {
      if (window.confirm(e.body.message + '\n\nRemove it anyway?')) return deleteMargin(ucc, true);
      return;
    }
    toast('Could not remove', apiMessage(e), 'bad');
  }
}

/**
 * Zero every margin. The nightly job calls the same endpoint; this is the manual
 * door, and it asks twice because there is no undo beyond re-uploading the file.
 */
async function resetMargins() {
  var n = (STATE.margins || []).filter(function (m) { return Number(m.available) !== 0; }).length;
  if (!n) { toast('Nothing to zero', 'Every margin is already zero.', 'warn'); return; }
  if (!window.confirm('Set ' + n + ' client margin(s) to zero?\n\n' +
      'Each change is written to the margin history. No bid can pass the margin check ' +
      'until the day\'s figures are uploaded again.')) return;
  try {
    var r = await api('/margin/reset', { method: 'POST', body: { note: 'manual reset from Masters' } });
    toast('Margins zeroed', r.clients + ' client(s) set to zero.', 'ok');
    loadMargins();
  } catch (e) { toast('Reset failed', apiMessage(e), 'bad'); }
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
          input = '<select data-grant="ofs-masters" data-set="' + esc(r.key) + '">' + r.choices.map(function (c) {
            return '<option' + (String(r.value) === c ? ' selected' : '') + '>' + esc(c) + '</option>';
          }).join('') + '</select>';
        } else if (r.kind === 'bool') {
          input = '<select data-grant="ofs-masters" data-set="' + esc(r.key) + '">' +
            '<option value="1"' + (String(r.value) === '1' ? ' selected' : '') + '>Yes</option>' +
            '<option value="0"' + (String(r.value) === '0' ? ' selected' : '') + '>No</option></select>';
        } else {
          input = '<input type="' + (r.kind === 'number' ? 'number' : 'text') + '" data-grant="ofs-masters" ' +
            'data-set="' + esc(r.key) + '" value="' + esc(r.value == null ? '' : r.value) + '"' +
            (r.kind === 'time' ? ' placeholder="15:15"' : '') + ' style="width:100%">';
        }
        return '<tr>' +
          '<td><b>' + esc(r.label) + '</b><br><span class="m" style="font-size:11px;color:var(--muted)">' +
            esc(r.key) + '</span></td>' +
          '<td>' + input + '</td>' +
          '<td><button class="mini" data-grant="ofs-masters" data-save="' + esc(r.key) + '">Save</button></td>' +
          '<td style="white-space:normal;font-size:11.5px;color:var(--muted);max-width:380px">' +
            esc(r.hint) + '</td>' +
        '</tr>';
      }).join('') + '</tbody>';
    applyGrants();   // the rows were just built, so re-run the sweep over them
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
    toast('Not saved', apiMessage(e), 'bad');
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

// Every column the importer reads, in the order the sample file uses. series,
// bse_scrip_code and cutoff_flag were missing from the template for the same reason
// they were missing from the form — and the BSE scrip code has no other way in.
var ISSUE_TEMPLATE =
  'symbol,company,isin,exchange,bse_scrip_code,series,floor_price,cut_price_min,tick,lot,' +
  'issue_qty,retail_qty,discount_pct,cutoff_flag,hni_open,hni_close,ret_open,ret_close\r\n' +
  'COALINDIA,Coal India Ltd,INE522F01014,BOTH,533278,EQ,385,385,0.05,1,' +
  '50000000,5000000,5,Y,2026-09-02T09:15,2026-09-02T15:15,2026-09-03T09:15,2026-09-03T15:15\r\n';

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
        // These three used to be droppable only because the importer ignored them —
        // the same gap the manual form had. The BSE scrip code has no other way in
        // at all, and a file without it produces a BSE bid file the exchange refuses.
        series: r.series ? String(r.series).toUpperCase() : 'EQ',
        bse_scrip_code: r.bse_scrip_code ? String(r.bse_scrip_code).trim() : null,
        cutoff_flag: r.cutoff_flag == null || r.cutoff_flag === ''
          ? true : !/^(0|n|no|false)$/i.test(String(r.cutoff_flag).trim()),
        // Blank is legitimate: NSE's FAQ (Q12) says the seller need not publish a
        // floor before the offer opens.
        floor_price: r.floor_price === '' || r.floor_price == null ? null : Number(r.floor_price),
        cut_price_min: r.cut_price_min ? Number(r.cut_price_min) : null,
        tick: r.tick ? Number(r.tick) : 0.05,
        lot: r.lot ? Number(r.lot) : 1,
        issue_qty: r.issue_qty ? Number(r.issue_qty) : null,
        retail_qty: r.retail_qty ? Number(r.retail_qty) : null,
        discount_pct: r.discount_pct ? Number(r.discount_pct) : 0,
        hni_open: r.hni_open, hni_close: r.hni_close, ret_open: r.ret_open, ret_close: r.ret_close
      };
      if (missing.length) o.__error = 'missing ' + missing.join(', ');
      else if (o.floor_price != null && (!isFinite(o.floor_price) || o.floor_price <= 0)) {
        o.__error = 'floor_price must be a positive number, or blank if it is not published yet';
      } else if (o.exchange !== 'NSE' && !o.bse_scrip_code) {
        o.__error = 'bse_scrip_code is required for a BSE or BOTH issue';
      }
      else if (new Date(o.hni_close) <= new Date(o.hni_open)) o.__error = 'hni_close must be after hni_open';
      else if (new Date(o.ret_close) <= new Date(o.ret_open)) o.__error = 'ret_close must be after ret_open';
      return o;
    });
    importPreview('Issue master — ' + fileName,
      [{ key: 'symbol', label: 'Symbol' }, { key: 'company', label: 'Company' }, { key: 'isin', label: 'ISIN' },
       { key: 'exchange', label: 'Exch' }, { key: 'bse_scrip_code', label: 'BSE code' },
       { key: 'floor_price', label: 'Floor' }, { key: 'discount_pct', label: 'Disc %' },
       { key: 'cutoff_flag', label: 'Cut-off' },
       { key: 'hni_open', label: 'HNI open' }, { key: 'hni_close', label: 'HNI close' },
       { key: 'ret_open', label: 'Retail open' }, { key: 'ret_close', label: 'Retail close' }],
      parsed,
      'Windows are read in the browser’s timezone (IST). Rows are posted one by one — a duplicate symbol/ISIN for the same day is rejected by the database.',
      async function (valid) {
        var ok = 0, failed = [];
        for (var i = 0; i < valid.length; i++) {
          var row = Object.assign({}, valid[i]); delete row.__error;
          try { await api('/issues', { method: 'POST', body: row }); ok++; }
          catch (e) { failed.push(row.symbol + ': ' + (apiMessage(e))); }
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
        } catch (e) { toast('Import failed', apiMessage(e), 'bad'); }
      });
  });
}

/* ---------------- archive ---------------- */
function archiveRow(i) {
  return '<tr data-arch="' + i.id + '">' +
    '<td><b>' + esc(i.symbol) + '</b>' +
      '<div class="sub">' + esc(i.company || '') + '</div>' +
      '<div class="sub m">' + esc(i.isin || '') + ' · ' + esc(i.exchange) + '</div></td>' +
    '<td class="m">' + (i.issue_date ? dtDate(i.issue_date + 'T00:00:00+05:30') : '—') + '</td>' +
    '<td class="n">' + inr(i.floor_price) + '</td>' +
    '<td class="n">' + inr(i.bid_count, 0) +
      '<div class="sub">' + inr(i.client_count, 0) + ' client(s)</div></td>' +
    '<td class="n">' + inr(i.total_qty, 0) + '</td>' +
    '<td class="n">' + crore(i.total_value) + '</td>' +
    '<td class="n">' + inr(i.allot_qty, 0) +
      '<div class="sub">' + inr(i.files_generated, 0) + ' file(s)</div></td>' +
    '<td class="m">' + (i.archived_at ? dt(i.archived_at) : '—') + '</td>' +
    '<td class="act"><button class="mini" data-detail="' + i.id + '">Open</button> ' +
        '<button class="mini" data-grant="ofs-masters" data-unarch="' + i.id + '">Restore</button></td></tr>';
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
    pagedTable('archive', $('#archiveTbl'), a, function (page) {
      return '<thead><tr><th>Scrip</th><th>Trading day</th>' +
      '<th class="n">Floor</th><th class="n">Bids</th>' +
      '<th class="n">Qty</th><th class="n">Value</th><th class="n">Allotted</th>' +
      '<th>Archived</th><th></th></tr></thead><tbody>' +
      page.map(archiveRow).join('') + '</tbody>';
    }, 'issues', loadArchive, 'Nothing archived yet.');
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
 * The issue's own terms, in the expander.
 *
 * The table above prints what a desk scans — scrip, floor, windows, status. The
 * rest of the contract (series, BSE code, reserved quantities, whether a cut-off
 * bid is allowed at all) lives here, one click away, instead of in four more
 * columns nobody could read without scrolling sideways.
 */
function issueTermsHtml(d) {
  var i = d.issue || {};
  // The summary view carries the traded terms but not tick/lot/series, so borrow
  // them from the master row when this is the Masters table. Elsewhere they are
  // simply not shown rather than shown wrong.
  var m = (STATE.issueRows || []).find(function (x) { return String(x.id) === String(i.id); }) || {};
  var f = function (k, v) {
    return '<div class="f"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  };
  var num = function (v, dp) { return v == null || v === '' ? '—' : inr(v, dp); };
  return '<h2 class="sec">Terms</h2>' +
    '<div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">' +
      f('ISIN', '<span class="m">' + esc(i.isin || '—') + '</span>') +
      f('Exchange', esc(i.exchange || '—')) +
      (m.series ? f('Series', esc(m.series)) : '') +
      (m.bse_scrip_code ? f('BSE scrip code', '<span class="m">' + esc(m.bse_scrip_code) + '</span>') : '') +
      f('Floor price', i.floor_price == null ? '—' : rupee(i.floor_price)) +
      f('Retail cut-off min', i.cut_price_min == null ? '—' : rupee(i.cut_price_min)) +
      f('Retail discount', num(i.discount_pct, 2) + '%') +
      (m.tick != null ? f('Tick', num(m.tick, 2)) : '') +
      (m.lot != null ? f('Lot', num(m.lot, 0)) : '') +
      f('Issue qty', num(i.issue_qty, 0)) +
      f('Reserved for retail', num(i.retail_qty, 0)) +
      f('HNI window', '<span class="m" style="font-size:11.5px">' + esc(dt(i.hni_open)) +
        ' → ' + esc(dt(i.hni_close)) + '</span>') +
      f('Retail window', '<span class="m" style="font-size:11.5px">' + esc(dt(i.ret_open)) +
        ' → ' + esc(dt(i.ret_close)) + '</span>') +
      (m.cutoff_flag === undefined ? ''
        : f('Cut-off bids', m.cutoff_flag === false ? 'Not allowed' : 'Allowed (Retail only)')) +
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
/**
 * Open/close the detail under a row. Clicking the row again — or its Open button,
 * or Close — collapses it. Only one is open at a time: two expanded rows in a bid
 * book push everything else off the screen.
 */
function markRowOpen(tr, on) {
  if (!tr) return;
  tr.classList.toggle('row-open', !!on);
  var b = tr.querySelector('[data-detail]');
  if (b) b.textContent = on ? 'Close' : 'Open';
}

async function toggleIssueRow(tr, id) {
  var open = tr.nextElementSibling;
  if (open && open.classList.contains('rowdet')) {
    open.remove();
    markRowOpen(tr, false);
    return;
  }
  // Close whatever else is open, and reset the row it belonged to.
  $$('.rowdet').forEach(function (x) {
    markRowOpen(x.previousElementSibling, false);
    x.remove();
  });
  markRowOpen(tr, true);

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
      issueSummaryHtml(d) + issueTermsHtml(d) + docsHtml(d) + '<div class="rowdet-more hide"></div>';

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
      if (e.target.closest('[data-collapse]')) { det.remove(); markRowOpen(tr, false); }
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
  } catch (e) { toast('Could not attach', apiMessage(e), 'bad'); }
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
  // The standalone window has no table to re-expand; it rebuilds itself.
  if (typeof renderIssueWindow === 'function' && document.getElementById('issueBox')) {
    return renderIssueWindow(id);
  }
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
  } catch (e) { toast('Archive failed', apiMessage(e), 'bad'); }
}

async function unarchive(id) {
  try {
    await api('/issues/' + id + '/unarchive', { method: 'POST', body: {} });
    toast('Restored', 'The issue is back in the OFS BackOffice.', 'ok');
    loadArchive(); loadIssues(); loadDash();
  } catch (e) { toast('Restore failed', e.message, 'bad'); }
}

/* ---------------- boot ---------------- */
/**
 * Auto-refresh. Default 30 seconds, with Manual as a real option — during a bidding
 * window a screen that redraws under a desk mid-read is worse than a stale one, and
 * the Refresh button is always there.
 *
 * Refreshing an as-on-date view is pointless (a past day does not change), so the
 * timer stands down when one is set and says so.
 */
function setAutoRefresh() {
  if (STATE.timer) clearInterval(STATE.timer);
  var ms = Number($('#autoRefresh').value) || 0;
  // Today is not a pin. Only a PAST date stops the refresh, because a past day
  // cannot change and today very much can.
  var pinned = !!asOnParam('#dashAsOn') &&
    !($('#dashScope') && $('#dashScope').value === 'all');
  if (ms && !pinned) {
    STATE.timer = setInterval(function () {
      loadDash();
      if (STATE.tab === 'book') loadBook();
    }, ms);
  }
  markRefreshed(pinned ? 'pinned' : null);
}

/**
 * What the dashboard is being asked for.
 *
 * One scope for the whole screen. The KPIs, the per-issue cards and the activity
 * list all take this — the bug was that the list defaulted to today while the totals
 * counted every live bid, so the screen showed 6 bids worth ₹6.38 L above a panel
 * reading "No bids yet". Both numbers were real; neither said which day it meant.
 */
function dashQuery() {
  if ($('#dashScope') && $('#dashScope').value === 'all') return '?scope=all';
  var asOn = asOnParam('#dashAsOn');
  return asOn ? '?as_on=' + encodeURIComponent(asOn) : '';
}

/** When the figures on screen were last read, in the desk's own timezone. */
function markRefreshed(mode) {
  var el = $('#refreshNote');
  if (!el) return;
  if (mode === 'pinned') {
    // This is what "the data is not refreshing" was: a past date pinned, and the
    // reason whispered in a grey tag. It has to be impossible to miss.
    el.textContent = 'PAUSED — as-on date set';
    el.classList.add('warn-tag');
    return;
  }
  el.classList.remove('warn-tag');
  var d = new Date();
  var p = function (x) { return String(x).padStart(2, '0'); };
  el.textContent = 'updated ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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
    ME = me;
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
      // Say WHY the session ended. "session_idle" after a 30-minute break is a
      // different message from "someone signed in elsewhere", and a desk that is
      // told the wrong one goes looking for a security problem that is not there.
      var code = (e.body && e.body.error) || '';
      var reason = code === 'session_superseded' || code === 'session_unknown' ? 'superseded'
                 : code === 'session_idle' ? 'idle'
                 : code === 'session_expired' ? 'expired'
                 : code === 'session_revoked' ? 'revoked'
                 : '';
      location.replace('/backoffice/login.html' + (reason ? '?reason=' + reason : ''));
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
  if (ready) applyGrants();

  // An empty date box reads as broken, and the first thing anyone does with it is
  // type a date — which then silently becomes a filter. Show today instead; today is
  // sent as no filter at all (asOnParam), so the view is unchanged.
  primeDateBox('#dashAsOn');
  primeDateBox('#bkAsOn');

  $$('#tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
  $$('[data-mtab]').forEach(function (b) { b.addEventListener('click', function () { showMTab(b.dataset.mtab); }); });
  $('#btnRefresh').addEventListener('click', function () { loadDash(); if (STATE.tab === 'book') loadBook(); });
  $('#autoRefresh').addEventListener('change', setAutoRefresh);
  $('#dashAsOn').addEventListener('change', function () { setAutoRefresh(); loadDash(); });
  $('#dashShowAll').addEventListener('change', function () { if (STATE.dash) renderDash(STATE.dash); });
  $('#dashScope').addEventListener('change', function () { setAutoRefresh(); loadDash(); });
  $('#dashToday').addEventListener('click', function () {
    $('#dashAsOn').value = todayIST(); setAutoRefresh(); loadDash();
  });
  $('#bkAsOn').addEventListener('change', function () { resetPage('bids'); loadBook(); });
  $('#bkToday').addEventListener('click', function () {
    $('#bkAsOn').value = todayIST(); resetPage('bids'); loadBook();
  });
  $('#bkBranch').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadBook(); });
  $('#bkCsv').addEventListener('click', downloadBookCsv);
  $('#bkGo').addEventListener('click', function () { resetPage('bids'); loadBook(); });
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
  $('#pbPlace').addEventListener('click', function () { placeBid(false); });
  $('#pbDefault').addEventListener('click', fillSuggestedBid);
  $('#pbUcc').addEventListener('input', onUccTyped);
  // Everything on this form is derived from something else on it, so one handler
  // recomputes the lot rather than six that each know about two fields.
  ['#pbIssue', '#pbExch', '#pbCat', '#pbType', '#pbQty', '#pbPrice'].forEach(function (sel) {
    $(sel).addEventListener('change', refreshBidForm);
    $(sel).addEventListener('input', refreshBidForm);
  });
  $('#pbIssue').addEventListener('change', function () { renderIssueInfo(); loadExistingBids(); });
  $('#pbUcc').addEventListener('change', loadExistingBids);
  $('#pbExisting').addEventListener('click', function (e) {
    var c = e.target.closest('[data-cancel]');
    if (c) return cancelBid(c.dataset.cancel);
    var m = e.target.closest('[data-edit]');
    if (m) return startModify(m.dataset.edit);
  });
  // The cards container is #issueCards. It was bound to #dashIssues, which does not
  // exist, so "Bid on this issue" silently did nothing — $() returns null and the
  // listener was never attached.
  $('#issueCards').addEventListener('click', function (e) {
    var b = e.target.closest('[data-bidon]');
    if (b) bidOnIssue(b.dataset.bidon);
  });
  ['#exExch', '#exIssue', '#exCat', '#exCanc'].forEach(function (s) { $(s).addEventListener('change', previewExport); });
  $('#exPreview').addEventListener('click', previewExport);
  $('#exDownload').addEventListener('click', function () { downloadExport(); });
  $('#exFull').addEventListener('click', downloadFullExport);
  $('#exSummary').addEventListener('click', function (e) {
    var b = e.target.closest('[data-part]');
    if (b) downloadExport(b.dataset.part);
  });
  $('#miNew').addEventListener('click', function () { issueForm(); });
  $('#issueTbl').addEventListener('click', function (e) {
    var b = e.target.closest('[data-issedit]');
    if (b) { editIssue(b.dataset.issedit); return; }
    var d = e.target.closest('[data-detail]');
    if (d) { toggleIssueRow(d.closest('tr'), d.dataset.detail); return; }
    // The whole row opens it too — the same behaviour as the Archive table, so the
    // two lists do not need to be learned separately.
    if (!e.target.closest('a,button,input,select')) {
      var tr = e.target.closest('tr');
      var opener = tr && tr.querySelector('[data-detail]');
      if (opener) toggleIssueRow(tr, opener.dataset.detail);
    }
  });
  $('#miSync').addEventListener('click', syncIssues);
  $('#syRun').addEventListener('click', function () { startSync(); });
  $('#scSave').addEventListener('click', saveSchedule);
  $('#auGo').addEventListener('click', function () { loadAudit(0); });
  initPagers();
  $('#cirPoll').addEventListener('click', pollCirculars);

  $('#cirStatus').addEventListener('change', function () { resetPage('circulars'); loadCirculars(); });
  $('#cirEvery').addEventListener('change', function () {
    saveCircularSetting('circulars_poll_minutes', this.value, 'Checking every ' + this.value + ' minutes.');
  });
  $('#cirAuto').addEventListener('change', function () {
    saveCircularSetting('circulars_autocreate', this.value,
      this.value === '1' ? 'A provisional issue will be created for each new circular.'
                         : 'Circulars will be queued for review only.');
  });
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
    var l = e.target.closest('[data-mglog]');
    if (l) return marginHistory(l.dataset.mglog);
    var ed = e.target.closest('[data-mgedit]');
    if (ed) return editMargin(ed.dataset.mgedit);
    var dl = e.target.closest('[data-mgdel]');
    if (dl) return deleteMargin(dl.dataset.mgdel, false);
  });
  $('#mgReset').addEventListener('click', resetMargins);
  $('#mgFetch').addEventListener('click', fetchMarginClient);
  $('#mgUcc').addEventListener('input', marginGate);
  $('#mgUcc').addEventListener('keydown', function (e) { if (e.key === 'Enter') fetchMarginClient(); });
  $('#sySchedOpen').addEventListener('click', function () { $('#sySched').classList.toggle('hide'); });
  $('#arGo').addEventListener('click', function () { resetPage('archive'); loadArchive(); });
  $('#arQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { resetPage('archive'); loadArchive(); } });
  $('#arRun').addEventListener('click', runArchive);
  $('#archiveTbl').addEventListener('click', function (e) {
    var d = e.target.closest('[data-detail]');
    if (d) { toggleIssueRow(d.closest('tr'), d.dataset.detail); return; }
    // The whole row is a target too — a 60px button is a small thing to hit on a
    // phone. Links and the other buttons keep their own behaviour.
    if (!e.target.closest('a,button,input,select')) {
      var tr0 = e.target.closest('tr');
      var opener = tr0 && tr0.querySelector('[data-detail]');
      if (opener) { toggleIssueRow(tr0, opener.dataset.detail); return; }
    }
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

/**
 * Document controls appear inside markup that is rebuilt constantly — the row
 * expander on Issues and on Archive, and the standalone issue window — so they are
 * delegated from the document.
 *
 * Bound at module scope rather than inside boot(): issue.html loads this file for
 * its builders but never boots the desk, so anything registered in boot() is absent
 * there. That is why Attach link and Upload PDF did nothing in the standalone window.
 */
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

// app.js is also loaded by issue.html purely for its builders and api(); booting the
// desk there would bind handlers to elements that do not exist. The tab strip is the
// marker for "this is the desk".
document.addEventListener('DOMContentLoaded', function () {
  if (document.getElementById('tabs')) boot();
});
