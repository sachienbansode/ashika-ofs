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

  /**
   * A number as a spreadsheet writes it.
   *
   * Margin files do not arrive as bare digits. They come out of Excel and out of
   * the risk system with Indian digit grouping ("12,50,000"), a rupee sign, a
   * non-breaking space, or a negative in accountancy brackets. Number() answers
   * NaN to every one of those, the row is marked "available must be a number
   * >= 0", and the desk is told the upload failed on a file that is correct.
   *
   * So: strip the currency mark, the separators and the spaces; read (1,234) as
   * -1234; and still answer NaN when what is left is genuinely not a number, so
   * a real typo is rejected as loudly as before.
   */
  function csvNum(v) {
    if (typeof v === "number") return v;
    var s = String(v == null ? "" : v).trim();
    if (!s) return NaN;
    var neg = /^\(.*\)$/.test(s);
    if (neg) s = s.slice(1, -1);
    s = s.replace(/[\u20B9$]/g, "")
      .replace(/\u00A0/g, "")
      .replace(/^INR/i, "")
      .replace(/[,\s']/g, "")
      .trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    var n = Number(s);
    return neg ? -n : n;
  }

  root.csvParse = csvParse;
  root.csvObjects = csvObjects;
  root.csvNum = csvNum;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { csvParse: csvParse, csvObjects: csvObjects, csvNum: csvNum };
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
