'use strict';
/**
 * Attached documents. The database parts need a connection; what matters here is the
 * input handling, because every field comes from somewhere untrusted:
 *
 *  - a stored link is later rendered as an href, so `javascript:` must never survive;
 *  - an uploaded filename is attacker-controlled text, and "../../.env" is a filename;
 *  - the path on disk is derived from OUR name, never joined with anything supplied.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const d = require('../lib/issueDocs');

test('only http(s) links are stored', () => {
  assert.equal(d.safeUrl('https://nsearchives.nseindia.com/x/CMTR1.pdf'),
    'https://nsearchives.nseindia.com/x/CMTR1.pdf');
  assert.equal(d.safeUrl('http://bseindia.com/notice.pdf'), 'http://bseindia.com/notice.pdf');
  assert.equal(d.safeUrl('  https://x.com/a  '), 'https://x.com/a');

  // Each of these becomes a working attack the moment it is rendered as an href.
  assert.equal(d.safeUrl('javascript:alert(1)'), null);
  assert.equal(d.safeUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(d.safeUrl('file:///etc/passwd'), null);
  assert.equal(d.safeUrl('vbscript:msgbox'), null);
  assert.equal(d.safeUrl('not a url'), null);
  assert.equal(d.safeUrl(''), null);
  assert.equal(d.safeUrl(null), null);
});

test('a display name keeps nothing that could traverse or inject', () => {
  assert.equal(d.cleanName('NSE Circular CMTR-72975 (2026).pdf'), 'NSE Circular CMTR-72975 (2026).pdf');
  assert.equal(d.cleanName('../../.env'), '.. .. .env');   // separators become spaces
  assert.equal(d.cleanName('a/b\\c.pdf'), 'a b c.pdf');
  assert.equal(d.cleanName('<script>alert(1)</script>'), 'scriptalert(1) script');  // angle brackets gone
  assert.equal(d.cleanName('   '), null);
  assert.equal(d.cleanName('x'.repeat(400)).length, 120);
});

test('only document formats are accepted', () => {
  assert.equal(d.MIME['application/pdf'], '.pdf');
  assert.equal(d.MIME['application/zip'], '.zip');
  assert.equal(d.MIME['image/png'], '.png');
  // Anything that executes in a browser is absent, which is what makes the
  // inline Content-Disposition safe.
  assert.equal(d.MIME['text/html'], undefined);
  assert.equal(d.MIME['image/svg+xml'], undefined);
  assert.equal(d.MIME['application/javascript'], undefined);
});

test('the path on disk cannot be walked out of', () => {
  const inside = d.filePath({ file_name: 'abc123.pdf' });
  assert.ok(inside.startsWith(d.DIR + path.sep), inside);

  // Traversal is FLATTENED rather than rejected: basename() reduces these to a bare
  // name, so they resolve inside the document directory and can never reach /etc.
  // The startsWith check is the backstop if basename ever stops being enough.
  for (const evil of ['../../../etc/passwd', '/etc/passwd', '..\\..\\windows\\win.ini']) {
    const out = d.filePath({ file_name: evil });
    assert.ok(out === null || out.startsWith(d.DIR + path.sep), evil + ' escaped to ' + out);
    assert.ok(out === null || !out.includes('etc' + path.sep), evil + ' reached ' + out);
  }
  assert.equal(d.filePath({ file_name: '' }), null);
});

test('the upload cap is a real number, not a suggestion', () => {
  assert.ok(d.MAX_BYTES > 0 && d.MAX_BYTES <= 32 * 1024 * 1024);
});
