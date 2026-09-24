'use strict';
/**
 * The console, in the browser.
 *
 * Polling rather than a socket. A run is a minute or two and produces a few
 * hundred lines; a websocket would be a second transport, a second failure mode
 * and a reconnect to write, for a log that is perfectly happy arriving a second
 * late. The poll asks for the log FROM an offset, so it fetches what is new
 * rather than the whole file each time.
 */

var $ = function (s) { return document.querySelector(s); };
var WATCH = null;          // run id being followed
var AT = 0;                // bytes of its log already shown
var TIMER = null;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function api(path, opts) {
  var o = opts || {};
  var res = await fetch(path, {
    method: o.method || 'GET',
    headers: o.body && !(o.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: o.body instanceof FormData ? o.body : (o.body ? JSON.stringify(o.body) : undefined)
  });
  // The session expiring mid-poll should return you to the door, not fill the
  // log pane with the login page's HTML.
  if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  var j = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(j.message || j.error || (res.status + ''));
  return j;
}

/* ------------------------------------------------------------------ the shell */

$('#out').addEventListener('click', async function () {
  await fetch('/logout', { method: 'POST' });
  location.href = '/login';
});

$('#tpl').addEventListener('click', function (e) {
  e.preventDefault();
  // A plain navigation, so the browser saves it rather than this code holding
  // a blob nobody asked it to hold.
  location.href = '/api/template';
});

/* -------------------------------------------------------------- starting one */

$('#new').addEventListener('submit', async function (e) {
  e.preventDefault();
  var err = $('#newErr');
  err.classList.add('hide');
  var file = $('#plan').files[0];
  if (!file) { err.textContent = 'Choose the plan workbook.'; err.classList.remove('hide'); return; }

  var fd = new FormData();
  fd.append('plan', file);
  fd.append('env', $('#env').value.trim());
  fd.append('browser', $('#browser').value);
  fd.append('only', $('#only').value);

  $('#start').disabled = true;
  $('#start').textContent = 'Starting…';
  try {
    var r = await api('/api/runs', { method: 'POST', body: fd });
    follow(r.id);
    await loadRuns();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hide');
  } finally {
    $('#start').disabled = false;
    $('#start').textContent = 'Start run';
  }
});

$('#stop').addEventListener('click', async function () {
  if (!WATCH) return;
  if (!window.confirm('Stop run ' + WATCH + '?')) return;
  try { await api('/api/runs/' + WATCH + '/stop', { method: 'POST' }); }
  catch (e) { /* it finished on its own between the click and the call */ }
});

/* ------------------------------------------------------------- watching one */

function follow(id) {
  WATCH = id;
  AT = 0;
  $('#log').textContent = '';
  $('#live').classList.remove('hide');
  $('#liveId').textContent = id;
  if (TIMER) clearTimeout(TIMER);
  tick();
  $('#live').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function chip(status) {
  var k = status === 'passed' ? 'pass' : status === 'failed' ? 'fail'
        : status === 'running' ? 'run' : 'stop';
  return '<span class="chip ' + k + '">' + esc(status || 'unknown') + '</span>';
}

function counts(t) {
  if (!t) return '<span class="dim">no counts yet</span>';
  return '<b>' + t.cases + '</b> case(s)' +
    ' · <b style="color:var(--green)">' + t.passed + '</b> passed' +
    (t.failed ? ' · <b style="color:var(--red)">' + t.failed + '</b> failed' : ' · 0 failed') +
    (t.skipped ? ' · <b style="color:var(--amber)">' + t.skipped + '</b> skipped' : '');
}

async function tick() {
  if (!WATCH) return;
  try {
    var d = await api('/api/runs/' + WATCH + '?from=' + AT);
    if (d.log) {
      var el = $('#log');
      // Only stick to the bottom if the reader was already there — scrolling
      // somebody back down while they are reading a failure is maddening.
      var atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      el.textContent += d.log;
      if (atEnd) el.scrollTop = el.scrollHeight;
      AT = d.at;
    }
    var r = d.run || {};
    $('#liveChip').innerHTML = chip(r.status);
    $('#liveWhat').textContent =
      (r.env || '?') + ' · ' + (r.browser || '?') + ' · ' + (r.only || 'all') +
      ' · started ' + when(r.startedAt) + (r.by ? ' by ' + r.by : '');
    $('#liveCounts').innerHTML = counts(r.totals);
    $('#stop').classList.toggle('hide', !d.running);

    if (d.running) {
      TIMER = setTimeout(tick, 1200);
    } else {
      await loadRuns();
    }
  } catch (e) {
    TIMER = setTimeout(tick, 4000);
  }
}

/* ------------------------------------------------------------------ the list */

function when(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function took(a, b) {
  if (!a || !b) return '';
  var s = Math.round((new Date(b) - new Date(a)) / 1000);
  if (!isFinite(s) || s < 0) return '';
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

async function loadRuns() {
  try {
    var d = await api('/api/runs');
    $('#keep').textContent = 'Kept for ' + d.keepDays + ' days, then removed — along with the ' +
      'plan workbook and its credentials.';
    var rows = d.runs || [];
    var body = rows.length ? rows.map(function (r) {
      return '<tr>' +
        '<td class="m"><a href="#" data-watch="' + esc(r.id) + '">' + esc(r.id) + '</a></td>' +
        '<td>' + chip(r.status) + '</td>' +
        '<td>' + esc(r.env || '') + '<span class="dim"> · ' + esc(r.browser || '') +
          ' · ' + esc(r.only || 'all') + '</span></td>' +
        '<td class="counts">' + counts(r.totals) + '</td>' +
        '<td class="dim">' + when(r.startedAt) +
          (took(r.startedAt, r.finishedAt) ? ' · ' + took(r.startedAt, r.finishedAt) : '') + '</td>' +
        '<td class="acts">' +
          '<a class="btn sm" href="/api/runs/' + esc(r.id) + '/xlsx">Excel</a> ' +
          '<a class="btn sm" href="/api/runs/' + esc(r.id) + '/html">HTML</a> ' +
          '<a class="btn sm" href="/api/runs/' + esc(r.id) + '/log">Log</a> ' +
          '<button class="btn sm bad" data-del="' + esc(r.id) + '">Delete</button>' +
        '</td></tr>';
    }).join('') : '<tr><td class="empty" colspan="6">No runs yet. Upload a plan above.</td></tr>';
    $('#runs').innerHTML =
      '<thead><tr><th>Run</th><th>Result</th><th>Against</th><th>Cases</th>' +
      '<th>When</th><th></th></tr></thead><tbody>' + body + '</tbody>';
  } catch (e) {
    $('#runs').innerHTML = '<tbody><tr><td class="empty">Could not load runs: ' +
      esc(e.message) + '</td></tr></tbody>';
  }
}

$('#runs').addEventListener('click', async function (e) {
  var w = e.target.closest('[data-watch]');
  if (w) { e.preventDefault(); follow(w.getAttribute('data-watch')); return; }
  var d = e.target.closest('[data-del]');
  if (d) {
    var id = d.getAttribute('data-del');
    if (!window.confirm('Delete run ' + id + ' and everything it produced?')) return;
    try {
      await api('/api/runs/' + id, { method: 'DELETE' });
      if (WATCH === id) { WATCH = null; $('#live').classList.add('hide'); }
      await loadRuns();
    } catch (e2) { window.alert(e2.message); }
  }
});

/* ---------------------------------------------------------------------- boot */

(async function () {
  try {
    var s = await api('/api/state');
    $('#who').textContent = s.user;
    $('#headless').classList.remove('hide');
    if (s.running) follow(s.running.id);     // a run survived a page reload
  } catch (e) { /* the door will have caught it */ }
  await loadRuns();
}());
