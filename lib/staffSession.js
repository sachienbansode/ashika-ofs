'use strict';
/**
 * Back-office sessions, owned by OFS.
 *
 * The rule this replaces: both OFS and the Stage API portal rotated
 * "admin-staging-api".users.active_sid — one column, two applications — so a sign-in
 * to either ended the other. Sessions now live in ofs.ofs_staff_session and the
 * platform column is left to the portal.
 *
 * Single-session still holds WITHIN OFS: signing in revokes this user's other OFS
 * sessions. Identity, role and page grants are still read live from the platform on
 * every request, so a disabled account or a withdrawn grant dies within seconds —
 * only the cross-application kill is gone, which is the point.
 */
const crypto = require('crypto');
const { SCHEMA, one, query } = require('../db/ofsAdapter');

/** Minutes of inactivity after which a session is refused. */
function idleMinutes() {
  const n = Number(process.env.OFS_STAFF_IDLE_MIN || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * Open a session and end this user's other OFS sessions.
 * `ttlHours` is the absolute ceiling; idleMinutes() is the one people meet.
 */
async function open(user, req, ttlHours) {
  const jti = crypto.randomUUID();
  const hours = Number(ttlHours) > 0 ? Number(ttlHours) : 8;

  await query(
    `UPDATE ${SCHEMA}.ofs_staff_session
        SET revoked_at = now(), revoked_why = 'superseded'
      WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);

  await query(
    `INSERT INTO ${SCHEMA}.ofs_staff_session
       (jti, user_id, email, expires_at, ip, user_agent)
     VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5,$6)`,
    [jti, user.id, String(user.email || '').toLowerCase(), String(hours),
     (req && req.ip ? String(req.ip).replace(/^::ffff:/, '') : null),
     (req && req.headers ? String(req.headers['user-agent'] || '').slice(0, 300) : null)]);

  return jti;
}

/**
 * Is this session still usable? Returns null when it is, or a reason code.
 *
 * Idle is checked against last_seen_at rather than issued_at, so a desk working
 * through a bidding window is never logged out mid-bid, and a desk that walked away
 * at 15:00 is.
 */
async function check(jti) {
  if (!jti) return 'no_session';
  const row = await one(
    `SELECT jti, revoked_at, expires_at, last_seen_at,
            (now() - last_seen_at) > ($2 || ' minutes')::interval AS idle
       FROM ${SCHEMA}.ofs_staff_session WHERE jti = $1`, [jti, String(idleMinutes())]);
  if (!row) return 'session_unknown';
  if (row.revoked_at) return 'session_revoked';
  if (new Date(row.expires_at) <= new Date()) return 'session_expired';
  if (row.idle) {
    // Mark it, so the row says why rather than merely looking stale.
    await query(`UPDATE ${SCHEMA}.ofs_staff_session
                    SET revoked_at = now(), revoked_why = 'idle'
                  WHERE jti = $1 AND revoked_at IS NULL`, [jti]).catch(() => {});
    return 'session_idle';
  }
  return null;
}

/** Best-effort liveness stamp. Never blocks the request it belongs to. */
function touch(jti) {
  if (!jti) return;
  query(`UPDATE ${SCHEMA}.ofs_staff_session SET last_seen_at = now() WHERE jti = $1`, [jti])
    .catch(() => {});
}

async function revoke(jti, why) {
  if (!jti) return;
  await query(`UPDATE ${SCHEMA}.ofs_staff_session
                  SET revoked_at = now(), revoked_why = $2
                WHERE jti = $1 AND revoked_at IS NULL`, [jti, why || 'logout']);
}

module.exports = { idleMinutes, open, check, touch, revoke };
