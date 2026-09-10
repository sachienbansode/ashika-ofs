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

  // Named on window so app.js can call it back after a document is attached or
  // removed — this page has no table to re-expand, it just rebuilds itself.
  window.renderIssueWindow = function (issueId) {
    return api('/issues/' + encodeURIComponent(issueId) + '/summary').then(function (d) {
      document.title = d.issue.symbol + ' — OFS issue';
      // docsHtml belongs here as much as anywhere: this is the window someone opens
      // to read one issue in full, and the circular is part of reading it in full.
      box.innerHTML = issueHeadHtml(d, {}) + issueSummaryHtml(d) + docsHtml(d) + issueTablesHtml(d);
    }).catch(function (e) {
      box.innerHTML = '<div class="note bad">' + esc(e.status === 401
        ? 'Your session has ended — sign in to the OFS BackOffice and reopen this window.'
        : (e.message || 'Could not load this issue.')) + '</div>';
    });
  };

  window.renderIssueWindow(id);
})();
