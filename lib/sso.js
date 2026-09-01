'use strict';
/**
 * SSO ticket verification.
 *
 * Flow: the user is already signed in to the platform portal (having passed its
 * password + MFA). The portal mints a short-lived, single-use ticket and redirects
 * the browser to this app, which redeems it for an OFS session.
 *
 * OFS never sees a password. It re-reads the user from the platform's own tables on
 * redemption, so a disabled account or a changed role takes effect immediately —
 * the ticket asserts identity, never authority.
 *
 * Threat model for a token in a URL: it appears in browser history, proxy logs and
 * possibly a Referer header. Countered by a ~60s lifetime, single use enforced in
 * the database, and an audience/type check so a session token can never be replayed
 * as a ticket (and vice versa).
 */
const jwt = require('jsonwebtoken');
const { SCHEMA, one } = require('../db/ofsAdapter');

const AUDIENCE = 'ofs-desk';
const TYPE = 'sso-ticket';
const MAX_LIFETIME_S = 300;          // refuse a ticket minted with a long TTL

function secret() {
  const s = process.env.OFS_SSO_SECRET;
  if (!s) { const e = new Error('OFS_SSO_SECRET is not set'); e.code = 'SSO_UNCONFIGURED'; throw e; }
  return s;
}

/** Verify signature, audience, type and lifetime. Throws with .code on failure. */
function verifyTicket(token) {
  // Resolved BEFORE the try, so a missing secret surfaces as SSO_UNCONFIGURED
  // rather than being swallowed and reported as a bad ticket — the operator needs
  // to know it is their config, not the user's link.
  const key = secret();
  let claims;
  try {
    claims = jwt.verify(token, key, { audience: AUDIENCE, clockTolerance: 5 });
  } catch (e) {
    const err = new Error(e.name === 'TokenExpiredError' ? 'ticket expired' : 'invalid ticket');
    err.code = e.name === 'TokenExpiredError' ? 'TICKET_EXPIRED' : 'TICKET_INVALID';
    throw err;
  }
  if (claims.typ !== TYPE) {
    const e = new Error('wrong token type'); e.code = 'TICKET_INVALID'; throw e;
  }
  if (!claims.jti || !claims.sub) {
    const e = new Error('ticket missing jti or sub'); e.code = 'TICKET_INVALID'; throw e;
  }
  // A ticket minted with a generous TTL defeats the point of it being short-lived.
  if (claims.exp && claims.iat && (claims.exp - claims.iat) > MAX_LIFETIME_S) {
    const e = new Error('ticket lifetime too long'); e.code = 'TICKET_INVALID'; throw e;
  }
  return claims;
}

/**
 * Redeem atomically. The INSERT is the lock: a second attempt with the same jti
 * hits the primary key and is refused, so a replay cannot succeed even if two
 * requests race.
 */
async function redeem(claims, ip) {
  try {
    await one(
      `INSERT INTO ${SCHEMA}.ofs_sso_ticket (jti, user_id, email, issued_at, expires_at, ip)
       VALUES ($1,$2,$3,to_timestamp($4),to_timestamp($5),$6) RETURNING jti`,
      [claims.jti, String(claims.sub), claims.email || null,
       claims.iat || Math.floor(Date.now() / 1000), claims.exp || Math.floor(Date.now() / 1000),
       ip || null]);
  } catch (e) {
    if (e && e.code === '23505') {
      const err = new Error('ticket already used'); err.code = 'TICKET_REPLAYED'; throw err;
    }
    throw e;
  }
  return true;
}

/** Housekeeping — redeemed tickets older than a day carry no further value. */
async function prune() {
  try {
    await one(`DELETE FROM ${SCHEMA}.ofs_sso_ticket
                WHERE expires_at < now() - interval '1 day' RETURNING jti`);
  } catch (e) { /* best effort */ }
}

module.exports = { AUDIENCE, TYPE, MAX_LIFETIME_S, verifyTicket, redeem, prune };
