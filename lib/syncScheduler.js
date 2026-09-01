'use strict';
/**
 * The scheduled pull.
 *
 * Deliberately simple: one timer that wakes every minute, asks the settings table
 * whether it is due, and starts a run if so. Cheap, and it means the frequency can
 * be changed from the desk and take effect on the next minute — no restart, no cron
 * entry on the VM to keep in step with the database.
 *
 * Two guards worth knowing about:
 *  - Due-ness is measured from the LAST RUN IN THE DATABASE, not from a counter in
 *    this process, so a restart does not reset the clock or cause a double pull.
 *  - The unique index from migration 007 means only one pull can be in flight, so a
 *    slow run cannot overlap the next tick.
 */
const { SCHEMA, one } = require('../db/ofsAdapter');
const settings = require('./settings');
const runner = require('./syncRunner');
const { marketState } = require('./marketHours');
const archiver = require('./archiver');
const audit = require('./audit');

const TICK_MS = 60 * 1000;
let timer = null;
let lastTick = null;

const MIN_MINUTES = 5;        // a tighter loop would hammer the exchange for nothing
const MAX_MINUTES = 24 * 60;

function everyMinutes(s) {
  const n = Number(s.sync_every_minutes);
  if (!Number.isFinite(n)) return 60;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)));
}

async function lastRun() {
  return one(
    `SELECT id, started_at, finished_at, status, trigger
       FROM ${SCHEMA}.ofs_sync_run
      WHERE trigger = 'schedule'
      ORDER BY started_at DESC LIMIT 1`);
}

/** Everything the desk needs to draw the schedule panel, and the tick needs to decide. */
async function status(now) {
  const s = await settings.all();
  const at = now || new Date();
  const enabled = String(s.sync_enabled || '0') === '1';
  const every = everyMinutes(s);
  const marketOnly = String(s.sync_market_only || '1') === '1';
  const market = marketState(s, at);
  const last = await lastRun();

  const dueAt = last ? new Date(new Date(last.started_at).getTime() + every * 60000) : at;
  const overdue = at >= dueAt;
  const live = await one(`SELECT id, progress, started_at FROM ${SCHEMA}.ofs_sync_run WHERE status = 'running'`);

  return {
    enabled,
    every_minutes: every,
    exchanges: runner.parseExchanges(s.sync_exchanges),
    market_only: marketOnly,
    market: { open: market.open, reason: market.reason, opens: market.opens,
              closes: market.closes, effective_close: market.effectiveClose },
    last_run: last || null,
    next_run_at: enabled ? dueAt.toISOString() : null,
    due: enabled && overdue && (!marketOnly || market.open),
    holding_for_market: enabled && overdue && marketOnly && !market.open,
    running: live || null,
    last_tick: lastTick
  };
}

/**
 * Move expired issues into the archive. Runs on the same tick as the pull but on its
 * own switch, because the two answer different questions: a desk may want the master
 * kept current without an automatic archive, or the reverse. Nothing is deleted —
 * bids, files, allotments and audit rows stay attached to the archived issue.
 */
async function archiveTick() {
  const s = await settings.all();
  if (String(s.archive_auto || '1') !== '1') return null;

  const out = await archiver.sweep({ actor: 'scheduler' });
  if (!out.archived.length) return null;

  console.log('[archive] archived ' + out.archived.length + ' expired issue(s): ' +
    out.archived.map((x) => x.symbol).join(', '));
  await audit.log({ user: { email: 'scheduler' } }, 'archive_run', 'ofs_issue', null, null,
    { after_days: out.after_days, archived: out.archived.length,
      symbols: out.archived.map((x) => x.symbol), by: 'schedule' });
  return out;
}

async function tick() {
  lastTick = new Date().toISOString();
  try {
    await archiveTick().catch((e) => console.error('[archive] sweep failed:', e.message));
    await runner.reapStale(15);
    const st = await status();
    if (!st.enabled || !st.due || st.running) return;

    const { run, busy } = await runner.start({
      exchanges: st.exchanges, trigger: 'schedule', actor: 'scheduler' });
    if (busy) return;

    console.log('[sync] scheduled pull #' + run.id + ' (' + st.exchanges.join(', ') + ')');
    await runner.run(run);
  } catch (e) {
    console.error('[sync] tick failed:', e.message);
  }
}

function start() {
  if (timer) return timer;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();          // never hold the process open
  console.log('[sync] scheduler started (checks every minute; frequency comes from ofs_setting)');
  setTimeout(() => { tick().catch(() => {}); }, 15 * 1000);   // let the pools warm first
  return timer;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, archiveTick, status, everyMinutes, MIN_MINUTES, MAX_MINUTES };
