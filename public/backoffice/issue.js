'use strict';
/**
 * The standalone issue window — the same builders app.js uses, so this page can
 * never drift from the in-table expander. Opened with "Open in new window" so a
 * reviewer can put two issues side by side, or print one for a file.
 */
(function () {
  var id = new URLSearchParams(location.search).get('id');
  var box = document.getElementById('issueBox');

  document.getElementById('btnClose').addEventListener('click', function () {
    window.close();
    // window.close() is refused for a tab the script did not open, so give a way back.
    setTimeout(function () { location.href = '/backoffice/'; }, 150);
  });

  if (!id) { box.innerHTML = '<div class="note bad">No issue id in the address.</div>'; return; }

  api('/issues/' + encodeURIComponent(id) + '/summary').then(function (d) {
    document.title = d.issue.symbol + ' — OFS issue';
    box.innerHTML = issueHeadHtml(d, {}) + issueSummaryHtml(d) + issueTablesHtml(d);
  }).catch(function (e) {
    box.innerHTML = '<div class="note bad">' + esc(e.status === 401
      ? 'Your session has ended — sign in on the desk and reopen this window.'
      : (e.message || 'Could not load this issue.')) + '</div>';
  });
})();
