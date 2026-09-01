/* Shared CSV parser: loaded as a plain script by the desk UI and required by tests.
   RFC4180-ish - quoted fields, embedded commas/newlines, CRLF or LF, BOM tolerated. */
(function (root) {
  'use strict';

  function csvParse(text) {
    var out = [], row = [], val = '', q = false, i = 0;
    text = String(text).replace(/^﻿/, '');
    while (i < text.length) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { val += '"'; i++; } else q = false; }
        else val += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(val); val = ''; }
      else if (c === '\n') { row.push(val); out.push(row); row = []; val = ''; }
      else if (c !== '\r') val += c;
      i++;
    }
    if (val !== '' || row.length) { row.push(val); out.push(row); }
    return out.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
  }

  /** Rows -> objects keyed by normalised header (lowercase, non-alphanumeric -> _). */
  function csvObjects(rows) {
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'); });
    return rows.slice(1).map(function (r) {
      var o = {};
      head.forEach(function (h, i) { o[h] = (r[i] == null ? '' : String(r[i]).trim()); });
      return o;
    });
  }

  root.csvParse = csvParse;
  root.csvObjects = csvObjects;
  if (typeof module !== 'undefined' && module.exports) module.exports = { csvParse: csvParse, csvObjects: csvObjects };
}(typeof globalThis !== 'undefined' ? globalThis : this));
