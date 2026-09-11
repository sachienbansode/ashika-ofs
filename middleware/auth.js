'use strict';
/**
 * auth - mirrors middleware/auth.js in omnenest-uploader-api (REUSE.md 2).
 * JWT proves identity ONLY. Role + permissions are loaded live from the platform
 * meta DB on every request, so a revoked grant takes effect immediately.
 *
 *   req.user = { sub, id, email, roleId, role, permissions: { pages: [...] } }
 */
const jwt = require('jsonwebtoken');
const { T, adminOne } = require('../db/adminAdapter');
const staffSession = require('../lib/staffSession');

const permCache = new Map();          // id -> { at, perms }
const TTL_MS = 15 * 1000;             // short: live enough, cheap enough for a bidding window

function invalidatePerms(userId) {
  if (userId == null) permCache.clear();
  else permCache.delete(String(userId));
}

const COOKIE = process.env.SESSION_COOKIE || 'ofs_session';

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  // The OFS session cookie, set by routes/auth.js after an SSO redemption. The
  // portal's own cookie ('ashika_session') is scoped to the portal's origin and
  // never reaches this app, which is why OFS issues its own.
  if (req.cookies && req.cookies[COOKIE]) return req.cookies[COOKIE];
  return null;
}

async function loadUser(id) {
  const hit = permCache.get(String(id));
  if (hit && Date.now() - hit.at < TTL_MS) return hit.perms;

  const row = await adminOne(
    `SELECT u.id, u.email, u.role_id AS "roleId",
            r.name AS role, r.permissions
       FROM ${T('users')} u
       JOIN ${T('roles')} r ON r.id = u.role_id
      WHERE u.id = $1 AND COALESCE(u.is_active, true) = true`,
    [id]
  );
  if (!row) return null;

  let perms = row.permissions;
  if (typeof perms === 'string') { try { perms = JSON.parse(perms); } catch (_) { perms = {}; } }
  const user = {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    role: row.role,
    permissions: { pages: (perms && perms.pages) || [] }
  };
  permCache.set(String(id), { at: Date.now(), perms: user });
  return user;
}

async function authMiddleware(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'unauthenticated' });

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: process.env.JWT_ISSUER || undefined,
      clockTolerance: 5
    });
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  const id = claims.id != null ? claims.id : claims.sub;
  let user;
  try { user = await loadUser(id); }
  catch (e) { console.error('[auth] perm load failed:', e.message); return res.status(503).json({ error: 'auth_unavailable' }); }
  if (!user) return res.status(401).json({ error: 'user_inactive' });

  /*
   * Single active session WITHIN OFS, tracked in ofs.ofs_staff_session.
   *
   * It used to be users.active_sid — one column on the platform's users table that
   * the Stage API portal rotates too, so signing in to either application ended the
   * other. That is why people were being logged out at random. OFS now owns its own
   * session and leaves that column to the portal.
   *
   * A token minted before this change carries no jti; it is refused rather than
   * waved through, so the rule cannot be skipped by presenting an old token.
   */
  const reason = await staffSession.check(claims.jti).catch((e) => {
    console.error('[auth] session check failed:', e.message);
    return 'session_store_unavailable';
  });
  if (reason === 'session_store_unavailable') return res.status(503).json({ error: reason });
  if (reason) return res.status(401).json({ error: reason === 'no_session' ? 'session_superseded' : reason });

  staffSession.touch(claims.jti);
  req.user = Object.assign({ sub: claims.sub, jti: claims.jti }, user);
  next();
}

module.exports = { authMiddleware, invalidatePerms, loadUser };
