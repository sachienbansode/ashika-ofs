'use strict';
/** Mirrors lib/pii.js in omnenest-uploader-api (REUSE.md 4). Masking is unconditional. */

function maskMobile(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 5) return d ? '•'.repeat(d.length) : '';
  return '•'.repeat(Math.max(0, d.length - 4)) + d.slice(-4);
}

function maskEmail(v) {
  const s = String(v || '');
  const i = s.indexOf('@');
  if (i < 1) return s ? '•••' : '';
  const user = s.slice(0, i), dom = s.slice(i);
  const keep = user.length <= 2 ? 1 : 2;
  return user.slice(0, keep) + '•'.repeat(Math.max(2, user.length - keep)) + dom;
}

function maskPan(v) {                 // keep last 5
  const s = String(v || '').toUpperCase();
  return s.length <= 5 ? s : '•'.repeat(s.length - 5) + s.slice(-5);
}

function maskAadhaar(v) {             // keep last 4
  const d = String(v || '').replace(/\D/g, '');
  return d.length <= 4 ? d : '•'.repeat(d.length - 4) + d.slice(-4);
}

const PII_COLUMNS = {
  mobile: maskMobile, mobile_no: maskMobile, phone: maskMobile, contact: maskMobile,
  email: maskEmail, email_id: maskEmail,
  pan: maskPan, pan_no: maskPan, pan_number: maskPan,
  aadhaar: maskAadhaar, aadhar: maskAadhaar, aadhaar_no: maskAadhaar
};

function isPiiColumn(col) {
  return Object.prototype.hasOwnProperty.call(PII_COLUMNS, String(col || '').toLowerCase());
}

function maskByColumn(col, value) {
  const fn = PII_COLUMNS[String(col || '').toLowerCase()];
  return fn ? fn(value) : value;
}

/** Mask every PII column in a row / array of rows. Fail-closed: default is masked. */
function maskRow(row, allow) {
  if (allow === true) return row;
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) out[k] = maskByColumn(k, row[k]);
  return out;
}
function maskRows(rows, allow) {
  if (allow === true) return rows;
  return (rows || []).map((r) => maskRow(r, false));
}

module.exports = { maskMobile, maskEmail, maskPan, maskAadhaar, maskByColumn, isPiiColumn, maskRow, maskRows, PII_COLUMNS };
