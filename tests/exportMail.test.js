'use strict';
/**
 * The day's exchange files, emailed, and the earlier days the screen can now reach.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const em = require('../lib/exportMailer');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the schedule is read in IST, not the server clock', () => {
  // The server runs UTC. 19:30 UTC is 01:00 IST the NEXT day, and a job that
  // thought otherwise would send the wrong day's book, or send twice.
  assert.equal(em.istDate(new Date('2026-09-13T19:30:00Z')), '2026-09-14');
  assert.equal(em.istDate(new Date('2026-09-13T09:46:00Z')), '2026-09-13');
  // 09:46 UTC is 15:16 IST — the default send time.
  assert.equal(em.istMinutes(new Date('2026-09-13T09:46:00Z')), 15 * 60 + 16);
});

test('the time is configurable and a bad value falls back rather than never firing', () => {
  assert.equal(em.hhmmToMinutes('15:16', 0), 15 * 60 + 16);
  assert.equal(em.hhmmToMinutes('09:05', 0), 9 * 60 + 5);
  assert.equal(em.hhmmToMinutes('23:59', 0), 23 * 60 + 59);
  for (const bad of ['', null, '25:00', '15:60', 'abc', '3pm']) {
    assert.equal(em.hhmmToMinutes(bad, 916), 916, JSON.stringify(bad) + ' should fall back');
  }
  assert.match(read('lib/settings.js'), /export_email_time: process\.env\.OFS_EXPORT_EMAIL_TIME \|\| '15:16'/);
  assert.match(read('lib/settings.js'), /export_email_enabled: '1'/, 'on by default, as asked');
});

test('it fires at or after the set minute, not only exactly on it', () => {
  // A tick missed because the process was restarting at 15:16 would otherwise skip
  // the whole day and the files would never go out.
  const src = read('lib/exportMailer.js');
  assert.match(src, /if \(istMinutes\(now\) < at\) return null;/);
  assert.ok(!/istMinutes\(now\) === at/.test(src), 'an exact match would drop a missed minute');
});

test('it runs once a day, and a restart cannot make it send twice', () => {
  const src = read('lib/exportMailer.js');
  // Due-ness comes from the database, not a counter in this process.
  assert.match(src, /async function alreadySentToday\(day\)/);
  assert.match(src, /settings\.all\(true\)/, 'the cache must be bypassed or a restart re-sends');
  // Marked BEFORE sending: a send that throws half way must not retry every minute.
  const tick = /async function tick\([\s\S]*?\n}/.exec(src)[0];
  assert.ok(tick.indexOf('markSent') < tick.indexOf('sendFor'),
    'mark the day before sending, or a failure loops all afternoon');
});

test('the emailed file is built by the same code the screen downloads', () => {
  // Two builders would produce two different files for the same bids, and the one
  // nobody looked at is the one that gets uploaded.
  assert.match(read('lib/exportMailer.js'), /exportBuild\.buildFile\(exch, \{ issue_id/);
  assert.match(read('routes/export.js'), /const buildFile = exportBuild\.buildFile;/);
  assert.match(read('lib/exportBuild.js'), /module\.exports = \{ buildFile, collect/);
});

test('it only builds for exchanges the desk is live on', () => {
  const src = read('lib/exportMailer.js');
  assert.match(src, /domain\.exchangesFor\(issue, s\)/);
  assert.match(src, /domain\.allowedExchanges\(s\)/);
  // An empty file is skipped rather than attached — an empty bid file uploaded to
  // an exchange is not harmless.
  assert.match(src, /if \(!pf\.rowCount\) continue;/);
});

test('an issue that cannot be built is named, not dropped', () => {
  const src = read('lib/exportMailer.js');
  assert.match(src, /problems\.push\(\{ symbol: issue\.symbol/);
  assert.match(src, /Not built/);
});

test('a mail failure never stops tomorrow', () => {
  assert.match(read('lib/syncScheduler.js'),
    /await exportMail\.tick\(\)\.catch\(\(e\) => console\.error\('\[export-mail\] tick failed:'/);
});

test('the mailer can carry an attachment, and only when there is one', () => {
  const src = read('lib/mailer.js');
  assert.match(src, /async function send\(\{ to, subject, html, purpose, triggeredBy, ip, attachments \}\)/);
  assert.match(src, /if \(attachments && attachments\.length\) mail\.attachments = attachments;/,
    'an empty attachments array is a malformed multipart message on some servers');
});

test('the desk can download an earlier day', () => {
  // The server always took as_on; the screen never offered it, so only today's
  // file could ever be built.
  assert.match(read('public/backoffice/index.html'), /<input type="date" id="exAsOn"/);
  const app = read('public/backoffice/app.js');
  assert.match(app, /if \(on\) q\.push\('as_on=' \+ encodeURIComponent\(on\)\);/);
  // Today's date has to be IST, not the machine's.
  assert.match(app, /timeZone: 'Asia\/Kolkata'[\s\S]{0,120}?\$\('#exAsOn'\)\.value = ist;/);
  assert.match(read('lib/exportBuild.js'), /b\.created_at AT TIME ZONE 'Asia\/Kolkata'\)::date = \$/);
});

test('send-now is a copy, and does not cancel the scheduled send', () => {
  const src = read('routes/export.js');
  assert.match(src, /router\.post\('\/email', requirePage\(PAGE\), requireEdit\(PAGE\)/);
  const h = src.slice(src.indexOf("router.post('/email'"));
  assert.ok(!/markSent/.test(h.slice(0, 900)), 'sending by hand must not skip the scheduled send');
  assert.match(src, /Deliberately does NOT mark the day as sent/);
  // And it is audited like every other export.
  assert.match(src, /audit\.log\(req, 'export_email'/);
});
