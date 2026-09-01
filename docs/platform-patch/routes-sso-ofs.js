'use strict';
/**
 * ============================================================================
 * DROP-IN FILE FOR omnenest-uploader-api  —  save as routes/ssoOfs.js
 * ============================================================================
 *
 * Mints a short-lived, single-use ticket for an ALREADY AUTHENTICATED portal
 * session and redirects the browser to the OFS desk, which redeems it.
 *
 * The portal stays the only place a password or an OTP is ever entered. This
 * endpoint asserts "this session is user X, and MFA was satisfied" — nothing more.
 * The OFS app re-reads the user from the database on redemption, so a disabled
 * account or a changed role takes effect immediately.
 *
 * WIRING (two lines in app.js, after authMiddleware is available):
 *     const ssoOfs = require('./routes/ssoOfs');
 *     app.use('/api/sso/ofs', authMiddleware, ssoOfs);
 *   ^ authMiddleware is what makes this safe: an unauthenticated caller must never
 *     reach it, or it becomes a ticket vending machine.
 *
 * ENV (both apps must agree on the secret):
 *     OFS_SSO_SECRET=<long random string>      # identical in the OFS app's .env
 *     OFS_APP_URL=http://20.244.33.142         # where to send the browser
 *
 * Generate the secret once:  openssl rand -base64 48
 *
 * PORTAL LINK — add to the sidebar/nav, opening in a new tab:
 *     <a href="/api/sso/ofs" target="_blank" rel="noopener">OFS Desk</a>
 */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const router = express.Router();

const AUDIENCE = 'ofs-desk';     // must match lib/sso.js in the OFS app
const TYPE = 'sso-ticket';
const TTL_SECONDS = 60;          // the OFS app refuses anything over 300

router.get('/', async (req, res) => {
  const target = String(process.env.OFS_APP_URL || '').replace(/\/+$/, '');
  const secret = process.env.OFS_SSO_SECRET;

  if (!secret || !target) {
    console.error('[sso-ofs] OFS_SSO_SECRET and OFS_APP_URL must both be set');
    return res.status(503).send('OFS single sign-on is not configured.');
  }

  // req.user is populated by authMiddleware. Anything falsy here means the mount
  // is wrong — fail loudly rather than minting an anonymous ticket.
  const u = req.user;
  if (!u || !(u.id || u.sub)) return res.status(401).send('Not signed in.');

  // The portal only establishes a session AFTER its own login has completed —
  // including the OTP step for accounts where mfa_enabled or requires_mfa is set
  // (routes/auth.js returns mfa_required and issues no token until /login/otp
  // succeeds). So the existence of req.user is itself the assertion that MFA was
  // satisfied where it was required.
  //
  // If a future change lets a session exist mid-MFA, set this from an explicit
  // per-session flag instead — the OFS app refuses a ticket whose mfa is not true
  // for an account that requires it, so this must not become a rubber stamp.
  const mfaSatisfied = true;

  const now = Math.floor(Date.now() / 1000);
  const ticket = jwt.sign({
    sub: String(u.id || u.sub),
    email: u.email || null,
    sid: u.sid || null,           // ties the OFS session to users.active_sid
    mfa: mfaSatisfied,
    typ: TYPE,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + TTL_SECONDS
  }, secret, { audience: AUDIENCE });

  // 302 with the ticket in the query string. It is single-use and lives 60s, so a
  // copy left in history or a proxy log is spent by the time anyone reads it.
  res.redirect(target + '/auth/sso?t=' + encodeURIComponent(ticket));
});

module.exports = router;
