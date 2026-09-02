'use strict';
/**
 * Renders window.OFS_RULES into a container. Used by both front ends so the two can
 * never drift — a client and the back office reading different rules is worse than
 * either reading none.
 *
 *   renderRules(document.getElementById('rulesBox'))
 */
function renderRules(host, opts) {
  if (!host || !window.OFS_RULES) return;
  var R = window.OFS_RULES;
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g,
      function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  };
  var tab = (opts && opts.tab) || 'common';

  function ruleList(items) {
    return items.map(function (r) {
      return '<div class="rule"><h3>' + esc(r.h) + '</h3><p>' + esc(r.p) + '</p>' +
        (r.src ? '<span class="src">' + esc(r.src) + '</span>' : '') + '</div>';
    }).join('');
  }

  function exchangePane(key) {
    var e = R.exchanges[key];
    return '<p class="rules-src">Source: ' + esc(e.source) + '</p>' +
      (e.note ? '<div class="rules-note">' + esc(e.note) + '</div>' : '') +
      '<table class="rules-tbl"><thead><tr><th>Rule</th><th>' + esc(e.label) + '</th></tr></thead><tbody>' +
      e.rows.map(function (r) {
        return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function body() {
    if (tab === 'NSE' || tab === 'BSE') return exchangePane(tab);
    if (tab === 'desk') return ruleList(R.desk);
    return ruleList(R.common);
  }

  host.innerHTML =
    '<div class="rules-head"><h1>Bidding rules</h1>' +
    '<p>How an Offer for Sale works, and what Ashika applies on top. Updated ' + esc(R.updated) + '.</p></div>' +
    '<div class="rules-tabs">' +
      [['common', 'The rules'], ['NSE', 'NSE'], ['BSE', 'BSE'], ['desk', 'Ashika']]
        .map(function (t) {
          return '<button data-rtab="' + t[0] + '"' + (t[0] === tab ? ' class="on"' : '') + '>' +
            esc(t[1]) + '</button>';
        }).join('') +
    '</div><div class="rules-body">' + body() + '</div>';

  host.querySelectorAll('[data-rtab]').forEach(function (b) {
    b.addEventListener('click', function () { renderRules(host, { tab: b.dataset.rtab }); });
  });
}
