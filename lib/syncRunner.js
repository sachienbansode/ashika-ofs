'use strict';
/**
 * One exchange pull, recorded as it happens.
 *
 * The desk needs to see *why* a pull found nothing — "could not reach the exchange"
 * is useless when the real answer is "web fetching is switched off on purpose", or
 * "NSE answered 200 with an HTML shell". So every step is appended to the run row
 * with its own outcome, and the summary distinguishes:
 *
 *   disabled     EXCHANGE_WEB_FETCH is false (the default; see lib/issueSource/http.js)
 *   unreachable  nothing answered
 *   no_data      answered, but with nothing an issue could be built from
 *   ok           issues found
 *
 * Only one run may be in flight; the partial unique index in migration 007 enforces
 * that in the database rather than in a variable this process could lose.
 */
const { SCHEMA, one, rows, query } = require('../db/ofsAdapter');
const { sourceFor, capability } = require('./issueSource');
const settings = require('./settings');
const http = require('./issueSource/http');
const { upsertIssues } = require('./issueSync');

const EXCHANGES = ['NSE', 'BSE'];

function parseExchanges(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => EXCHANGES.indexOf(s) >= 0);
  return list.length ? Array.from(new Set(list)) : EXCHANGES.slice();
}

async function start({ exchanges, trigger, actor }) {
  const list = parseExchanges(exchanges);
  try {
    const run = await one(
      `INSERT INTO ${SCHEMA}.ofs_sync_run (trigger, actor, exchanges, steps)
       VALUES ($1,$2,$3,'[]'::jsonb) RETURNING *`,
      [trigger || 'manual', actor || null, list]);
    return { run, busy: false };
  } catch (e) {
    // 23505 = the one-live-run index. Hand back the run already going rather than
    // an error the desk has to interpret.
    if (e.code === '23505') {
      const live = await one(`SELECT * FROM ${SCHEMA}.ofs_sync_run WHERE status = 'running'`);
      if (live) return { run: live, busy: true };
    }
    throw e;
  }
}

async function step(runId, entry, progress) {
  await query(
    `UPDATE ${SCHEMA}.ofs_sync_run
        SET steps = steps || $2::jsonb,
            progress = greatest(progress, $3)
      WHERE id = $1`,
    [runId, JSON.stringify([Object.assign({ at: new Date().toISOString() }, entry)]), Number(progress) || 0]);
}

/** Runs to completion, updating the row as it goes. Never throws to the caller. */
async function execute(run) {
  const list = run.exchanges && run.exchanges.length ? run.exchanges : EXCHANGES.slice();
  const perExchange = [];
  const totals = { found: 0, inserted: 0, updated: 0, unchanged: 0, rejected: 0 };
  const share = 90 / list.length;
  let done = 0;

  if (!http.enabled()) {
    await step(run.id, {
      exchange: null, phase: 'preflight', outcome: 'disabled',
      message: 'Web fetching is off (EXCHANGE_WEB_FETCH=false). Both exchanges prohibit '
             + 'automated collection without written consent — import the T-2/T-1 member '
             + 'notice under Masters → Import issues CSV instead.'
    }, 5);
  }

  const cfg = await settings.all();

  for (const ex of list) {
    const src = sourceFor(ex);
    const cap = capability(ex);

    await step(run.id, { exchange: ex, phase: 'source', outcome: cap.level === 'api' ? 'ok' : 'disabled',
      message: 'Source: ' + src.chosen + '. ' + cap.detail }, Math.round(done * share) + 1);

    await step(run.id, { exchange: ex, phase: 'fetch', outcome: 'started', message: 'Contacting ' + ex + '…' },
      Math.round(done * share) + 2);

    let out;
    try {
      out = await src.fetchIssues(cfg);
    } catch (e) {
      perExchange.push({ exchange: ex, outcome: 'error', error: e.message, found: 0 });
      await step(run.id, { exchange: ex, phase: 'fetch', outcome: 'error', message: e.message },
        Math.round(++done * share));
      continue;
    }

    // Say exactly what each endpoint answered — this is the part that was invisible.
    for (const a of out.attempts || []) {
      await step(run.id, {
        exchange: ex, phase: 'endpoint', outcome: a.ok ? 'ok' : 'failed',
        url: a.url, status: a.status, rows: a.rows || 0,
        message: a.error || (a.ok ? (a.rows ? a.rows + ' row(s)' : 'answered, no issue rows') : 'HTTP ' + a.status)
      }, Math.round(done * share) + 4);
    }

    const outcome = !http.enabled() ? 'disabled'
      : !(out.attempts || []).some((a) => a.ok) ? 'unreachable'
      : out.issues.length ? 'ok' : 'no_data';

    let wrote = { inserted: 0, updated: 0, skipped: 0, detail: [] };
    if (out.issues.length) {
      wrote = await upsertIssues(out.issues, run.actor || 'schedule');
    }

    totals.found += out.issues.length;
    totals.inserted += wrote.inserted;
    totals.updated += wrote.updated;
    totals.unchanged += wrote.skipped;
    totals.rejected += (out.rejected || []).length;

    perExchange.push({
      exchange: ex, outcome, source: out.source || null,
      found: out.issues.length, inserted: wrote.inserted, updated: wrote.updated,
      unchanged: wrote.skipped, rejected: (out.rejected || []).length,
      detail: wrote.detail
    });

    await step(run.id, {
      exchange: ex, phase: 'write', outcome,
      message: outcome === 'ok'
        ? out.issues.length + ' issue(s): ' + wrote.inserted + ' new, ' + wrote.updated + ' updated, ' + wrote.skipped + ' unchanged'
        : outcome === 'disabled' ? 'Skipped — web fetching is off'
        : outcome === 'unreachable' ? 'No endpoint answered'
        : 'Answered, but nothing that parses as an OFS issue'
    }, Math.round(++done * share));
  }

  const anyOk = perExchange.some((p) => p.outcome === 'ok');
  const status = !anyOk ? 'failed'
    : perExchange.some((p) => p.outcome !== 'ok') ? 'partial'
    : 'ok';

  await query(
    `UPDATE ${SCHEMA}.ofs_sync_run
        SET finished_at = now(), status = $2, progress = 100,
            found = $3, inserted = $4, updated = $5, unchanged = $6, rejected = $7,
            summary = $8::jsonb, error = $9
      WHERE id = $1`,
    [run.id, status, totals.found, totals.inserted, totals.updated, totals.unchanged,
     totals.rejected, JSON.stringify({ exchanges: perExchange, web_fetch: http.enabled() }),
     status === 'failed'
       ? (http.enabled() ? 'No exchange returned usable issue data.'
                         : 'Web fetching is disabled (EXCHANGE_WEB_FETCH=false).')
       : null]);

  return { status, totals, perExchange };
}

/** Fire and forget: the desk polls the row. A crash must still close the run. */
function run(runRow) {
  return execute(runRow).catch(async (e) => {
    console.error('[sync] run', runRow.id, 'failed:', e.message);
    await query(
      `UPDATE ${SCHEMA}.ofs_sync_run
          SET finished_at = now(), status = 'failed', progress = 100, error = $2 WHERE id = $1`,
      [runRow.id, e.message]).catch(() => {});
  });
}

async function get(id) {
  return one(`SELECT * FROM ${SCHEMA}.ofs_sync_run WHERE id = $1`, [id]);
}

async function recent(limit) {
  return rows(
    `SELECT id, started_at, finished_at, trigger, actor, exchanges, status, progress,
            found, inserted, updated, unchanged, rejected, error
       FROM ${SCHEMA}.ofs_sync_run
      ORDER BY started_at DESC LIMIT $1`, [Math.min(Number(limit) || 20, 100)]);
}

/** A run whose process died mid-flight would block every later one. */
async function reapStale(maxMinutes) {
  const r = await query(
    `UPDATE ${SCHEMA}.ofs_sync_run
        SET status = 'failed', finished_at = now(), progress = 100,
            error = 'Interrupted — the app restarted while this pull was running'
      WHERE status = 'running' AND started_at < now() - ($1 || ' minutes')::interval`,
    [String(Number(maxMinutes) || 15)]);
  return (r && r.rowCount) || 0;
}

module.exports = { EXCHANGES, parseExchanges, start, run, execute, get, recent, reapStale };
