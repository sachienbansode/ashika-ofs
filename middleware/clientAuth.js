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
  // A client token carries a ucc; a branch/AP token carries a branch code. Either
  // is a session; neither is optional. The row below is what actually decides.
  if (!claims.jti || !(claims.ucc || claims.branch)) {
    return res.status(401).json({ error: 'invalid_session' });
  }

  let row;
  try {
    row = await one(
      `SELECT jti, client_ucc, actor_type, ap_id, branch_code, branch_name, login_email,
              revoked_at, expires_at
         FROM ${SCHEMA}.ofs_client_session WHERE jti = $1`, [claims.jti]);
  } catch (e) {
    return res.status(503).json({ error: 'session_store_unavailable' });
  }

  if (!row) return res.status(401).json({ error: 'session_unknown' });
  if (row.revoked_at) return res.status(401).json({ error: 'session_revoked' });
  if (new Date(row.expires_at) <= new Date()) return res.status(401).json({ error: 'session_expired' });

  /*
   * Two shapes of signed-in portal user, and the difference matters everywhere:
   *
   *   client            bound to ONE ucc
   *   ap | branch       bound to a BRANCHCODE, standing for that branch's clients
   *
   * req.portal is the one every scoped query should read. req.client is kept for the
   * routes that genuinely require a single client, and is deliberately left undefined
   * for a branch session — a branch reading req.client.ucc should fail loudly rather
   * than quietly act as whatever happened to be in the column.
   */
  req.portal = {
    kind: row.actor_type,                       // client | ap | branch
    ucc: row.client_ucc || null,
    branchCode: row.branch_code || null,
    branchName: row.branch_name || null,
    loginEmail: row.login_email || null,
    apId: row.ap_id,
    jti: row.jti
  };
  if (row.actor_type === 'client') {
    req.client = { ucc: row.client_ucc, actorType: row.actor_type, apId: row.ap_id, jti: row.jti };
  }

  // Best-effort liveness stamp; never block the request on it.
  query(`UPDATE ${SCHEMA}.ofs_client_session SET last_seen_at = now() WHERE jti = $1`, [row.jti])
    .catch(() => {});

  next();
}

/** Any signed-in portal user: a client, an AP or a branch. */
function requirePortal(req, res, next) {
  return requireClient(req, res, next);
}

/** A session bound to ONE client. Refuses a branch session rather than guessing. */
function requireSingleClient(req, res, next) {
  return requireClient(req, res, function () {
    if (!req.client || !req.client.ucc) {
      return res.status(400).json({ error: 'client_session_required',
        message: 'Choose a client first — this action is for one client at a time.' });
    }
    next();
  });
}

module.exports = { COOKIE, AUDIENCE, sign, cookieOpts, requireClient, requirePortal, requireSingleClient };
