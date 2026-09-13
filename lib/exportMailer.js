'use strict';
/**
 * The day's exchange files, emailed to the desk at a set time.
 *
 * Ashika's ask: at 15:16 IST — a minute after the desk cut-off — send whoever is
 * named in Settings the bid files for every issue that took bids that day, so the
 * upload does not depend on somebody being at the screen to press Download.
 *
 * Four things this does deliberately:
 *
 *   It builds through lib/exportBuild, the same function the Exchange files screen
 *   downloads through. An emailed file that differs by a column or a rounding from
 *   the one the desk sees would be the worst kind of bug — silent, and only
 *   discovered by the exchange.
 *
 *   It runs once per IST day, and it records that it ran in ofs_setting. Due-ness
 *   is read from the database, not from a counter in this process, so a restart at
 *   15:20 does not send the same files a second time.
 *
 *   It only sends where the desk is live. With BSE enabled and NSE not, there is no
 *   NSE file to build and sending an empty one would invite somebody to upload it.
 *
 *   It never throws. A mail failure is logged and the next day still runs.
 */
const { SCHEMA, rows } = require('../db/ofsAdapter');
const settings = require('./settings');
const mailer = require('./mailer');
const exportBuild = require('./exportBuild');
const domain = require('./domain');
const { brandedEmail } = require('./emailBranding');

const LAST_KEY = 'export_email_last';        // the IST date it last ran, in ofs_setting

const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const inr = (n, d) => Number(n || 0).toLocaleString('en-IN',
  { minimumFractionDigits: d == null ? 0 : d, maximumFractionDigits: d == null ? 0 : d });

/** Today in IST, as YYYY-MM-DD. The server runs UTC; the desk's day is IST. */
function istDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());
}

/** Minutes past IST midnight. */
function istMinutes(now) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now || new Date())
    .reduce((a, x) => (a[x.type] = x.value, a), {});
  return Number(p.hour) * 60 + Number(p.minute);
}

function hhmmToMinutes(v, fallback) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v || '').trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Every issue that took a bid on this IST day. */
async function issuesWithBidsOn(day) {
  return rows(
    `SELECT DISTINCT i.id, i.symbol, i.company, i.exchange
       FROM ${SCHEMA}.ofs_bid b
       JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
      WHERE b.status IN ('Live','Modified')
        AND (b.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
      ORDER BY i.symbol`, [day]);
}

/**
 * Build every file the day calls for: one per issue per exchange we are live on
 * and the issue is listed on.
 *
 * A file that would carry no rows is skipped rather than attached empty — an empty
 * bid file uploaded to an exchange is not harmless, and an attachment nobody can
 * use invites exactly that.
 */
async function buildDayFiles(day, s) {
  const out = [];
  const problems = [];
  const live = domain.allowedExchanges(s);
  for (const issue of await issuesWithBidsOn(day)) {
    for (const exch of domain.exchangesFor(issue, s)) {
      if (live.indexOf(exch) < 0) continue;
      try {
        const f = await exportBuild.buildFile(exch, { issue_id: String(issue.id), as_on: day });
        const parts = Number(f.parts) || 1;
        // BSE caps a file at 100 records, so one issue can be several files. Each
        // part is built separately, exactly as the screen downloads them.
        for (let part = 1; part <= parts; part++) {
          const pf = parts === 1 ? f
            : await exportBuild.buildFile(exch, { issue_id: String(issue.id), as_on: day, part: String(part) });
          if (!pf.rowCount) continue;
          out.push({ issue: issue, exchange: exch, part: part, parts: parts, file: pf });
        }
      } catch (e) {
        // An issue with no ISIN, or a cut-off bid with no floor, is refused by the
        // export guards. That is a real problem for the desk to fix, so it is named
        // in the email rather than dropped.
        problems.push({ symbol: issue.symbol, exchange: exch, message: e.message });
      }
    }
  }
  return { files: out, problems };
}

function emailBody(day, built, s) {
  const rowsHtml = built.files.map((f) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eaeef2;font-size:13px">
        <b>${esc(f.issue.symbol)}</b> · ${esc(f.exchange)}${f.parts > 1 ? ' · part ' + f.part + ' of ' + f.parts : ''}
        <div style="color:#6b7280;font-size:11px">${esc(f.file.fileName)}</div></td>
      <td align="right" style="padding:6px 10px;border-bottom:1px solid #eaeef2;font-size:13px">
        ${inr(f.file.rowCount)} bid(s)<div style="color:#6b7280;font-size:11px">₹${inr(f.file.totalValue)}</div></td></tr>`
  ).join('');

  const probs = built.problems.length
    ? `<div style="margin-top:16px;padding:11px 13px;background:#fdf3f3;border-left:3px solid #b3261e;border-radius:4px;font-size:13px">
         <b>Not built</b><ul style="margin:6px 0 0;padding-left:18px">` +
       built.problems.map((p) => `<li>${esc(p.symbol)} · ${esc(p.exchange)} — ${esc(p.message)}</li>`).join('') +
       `</ul></div>`
    : '';

  const inner = `
    <h2 style="margin:0 0 12px;font-size:17px;color:#243f8e">Exchange files — ${esc(day)}</h2>
    <p style="margin:0 0 14px">
      ${built.files.length
        ? 'The bid files for today are attached, one per issue per exchange.'
        : 'No bids were placed today, so there is no file to upload.'}
    </p>
    ${built.files.length
      ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"
                style="border-collapse:collapse;border:1px solid #eaeef2;border-radius:6px">${rowsHtml}</table>`
      : ''}
    ${probs}
    <p style="margin:16px 0 0;color:#6b7280;font-size:12px">
      Check each file against the Exchange files screen before uploading. Generated
      automatically at the time set in Settings; every download is recorded in the
      export audit log either way.
    </p>`;
  void s;
  return { subject: `OFS exchange files — ${day}` +
                    (built.files.length ? ` · ${built.files.length} file(s)` : ' · no bids'),
           html: brandedEmail(inner) };
}

/** Build and send. Returns what happened; never throws. */
async function sendFor(day, s, trigger) {
  const cfg = s || await settings.all();
  const to = String(cfg.export_email_to || '').trim();
  if (!to) return { sent: false, reason: 'no_recipient' };

  const built = await buildDayFiles(day, cfg);
  const msg = emailBody(day, built, cfg);
  const r = await mailer.send({
    to, subject: msg.subject, html: msg.html,
    purpose: 'ofs_export_files', triggeredBy: trigger || 'schedule',
    attachments: built.files.map((f) => ({
      filename: f.parts > 1 ? f.file.fileName.replace(/(\.[^.]+)$/, '_part' + f.part + '$1') : f.file.fileName,
      content: f.file.text,
      contentType: 'text/csv'
    }))
  });
  return { sent: !!r.sent, error: r.error || null, files: built.files.length,
           problems: built.problems.length, to: to, day: day };
}

/** Has it already run for this IST day? */
async function alreadySentToday(day) {
  const s = await settings.all(true);
  return String(s[LAST_KEY] || '') === day;
}

async function markSent(day) {
  await settings.set(LAST_KEY, day, 'schedule');
}

/**
 * One tick. Called every minute by the scheduler.
 *
 * Sends when the IST clock has reached the configured minute and today's send has
 * not happened. "Reached", not "equals": a tick missed because the process was
 * restarting at 15:16 would otherwise skip the day entirely, and the files would
 * not go out at all.
 */
async function tick(now) {
  const s = await settings.all();
  if (String(s.export_email_enabled == null ? '1' : s.export_email_enabled) !== '1') return null;
  const at = hhmmToMinutes(s.export_email_time, 15 * 60 + 16);
  if (istMinutes(now) < at) return null;

  const day = istDate(now);
  if (await alreadySentToday(day)) return null;
  // Marked BEFORE sending. A send that throws half way must not be retried every
  // minute for the rest of the day — the desk can resend by hand from the screen.
  await markSent(day);
  const out = await sendFor(day, s, 'schedule');
  if (!out.sent) console.warn('[export-mail]', day, 'not sent:', out.error || out.reason);
  return out;
}

module.exports = { tick, sendFor, buildDayFiles, istDate, istMinutes, hhmmToMinutes, LAST_KEY };
