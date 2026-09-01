'use strict';
/**
 * Client/AP session gate. Entirely separate from middleware/auth.js: a client is
 * NOT a platform user, holds no page grants, and must never satisfy requirePage.
 * Distinct cookie, distinct audience claim, distinct table.
 */
const jwt = require('jsonwebtoken');
const { SCHEMA, one, query } = require('../db/ofsAdapter');

const COOKIE = process.env.CLIENT_COOKIE || 'ofs_client';
const AUDIENCE = 'ofs-client';

function secret() {
  return process.env.CLIENT_JWT_SECRET || process.env.JWT_SECRET;
}

function sign(payload, jti, ttlHours) {
  return jwt.sign(Object.assign({}, payload, { jti }), secret(), {
    audience: AUDIENCE,
    expiresIn: (ttlHours || Number(process.env.CLIENT_SESSION_HOURS || 2)) + 'h'
  });
}

const cookieOpts = () => ({
  httpOnly: true,
  secure: String(process.env.COOKIE_SECURE || (process.env.NODE_ENV === 'production')) === 'true',
  sameSite: 'lax',
  path: '/',
  maxAge: Number(process.env.CLIENT_SESSION_HOURS || 2) * 60 * 60 * 1000
});

function tokenFrom(req) {
  if (req.cookies && req.cookies[COOKIE]) return req.cookies[COOKIE];
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/**
 * Requires a live client session. The JWT proves the cookie is ours; the session
 * row is what makes it revocable — a stateless token cannot be withdrawn, and a
 * client who signs out, or whom the desk cuts off, must lose access at once.
 */
async function requireClient(req, res, next) {
  const token = tokenFrom(req);
  if (!token) return res.status(401).json({ error: 'unauthenticated' });

  let claims;
  try {
    claims = jwt.verify(token, secret(), { audience: AUDIENCE, clockTolerance: 5 });
  } catch (e) {
    return res.status(401).json({ error: 'invalid_session' });
  }
  if (!claims.jti || !claims.ucc) return res.status(401).json({ error: 'invalid_session' });

  let row;
  try {
    row = await one(
      `SELECT jti, client_ucc, actor_type, ap_id, revoked_at, expires_at
         FROM ${SCHEMA}.ofs_client_session WHERE jti = $1`, [claims.jti]);
  } catch (e) {
    return res.status(503).json({ error: 'session_store_unavailable' });
  }

  if (!row) return res.status(401).json({ error: 'session_unknown' });
  if (row.revoked_at) return res.status(401).json({ error: 'session_revoked' });
  if (new Date(row.expires_at) <= new Date()) return res.status(401).json({ error: 'session_expired' });

  req.client = {
    ucc: row.client_ucc,
    actorType: row.actor_type,
    apId: row.ap_id,
    jti: row.jti
  };

  // Best-effort liveness stamp; never block the request on it.
  query(`UPDATE ${SCHEMA}.ofs_client_session SET last_seen_at = now() WHERE jti = $1`, [row.jti])
    .catch(() => {});

  next();
}

module.exports = { COOKIE, AUDIENCE, sign, cookieOpts, requireClient };
