'use strict';
/**
 * Session endpoints. OFS has no password of its own: the portal authenticates the
 * user (password + MFA), mints a single-use ticket, and redirects here.
 *
 *   portal  --redirect--> GET /auth/sso?t=<ticket>  --> sets ofs_session cookie --> /
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { T, adminOne } = require('../db/adminAdapter');
const sso = require('../lib/sso');
const audit = require('../lib/audit');

const router = express.Router();

const COOKIE = process.env.SESSION_COOKIE || 'ofs_session';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: String(process.env.COOKIE_SECURE || (process.env.NODE_ENV === 'production')) === 'true',
  sameSite: 'lax',        // 'lax' so the cookie survives the portal's cross-site redirect
  path: '/',
  maxAge: 8 * 60 * 60 * 1000
};

// A ticket is single-use, but rate-limit anyway so a stolen-ticket guessing loop
// cannot hammer the exchange.
const ssoLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

/** Re-read the user from the platform on every redemption — never trust the ticket. */
async function loadUser(id) {
  return adminOne(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.role_id AS "roleId",
            u.is_active, u.mfa_enabled, u.active_sid,
            r.name AS role, r.requires_mfa, r.permissions
       FROM ${T('users')} u
       JOIN ${T('roles')} r ON r.id = u.role_id
      WHERE u.id = $1`, [id]);
}

function issueSession(user, sid) {
  let perms = user.permissions;
  if (typeof perms === 'string') { try { perms = JSON.parse(perms); } catch (_) { perms = {}; } }
  return jwt.sign({
    sub: user.id, email: user.email,
    firstName: user.first_name, lastName: user.last_name,
    roleId: user.roleId, role: user.role,
    permissions: { pages: (perms && perms.pages) || [] },
    sid                                   // ties this session to the portal's active_sid
  }, process.env.JWT_SECRET, {
    issuer: process.env.JWT_ISSUER || undefined,
    expiresIn: process.env.JWT_EXPIRES_IN || '8h'
  });
}

/** Shared redemption path for both the redirect and the JSON exchange. */
async function redeemTicket(req, token) {
  const claims = sso.verifyTicket(token);          // throws with .code
  const user = await loadUser(claims.sub);

  if (!user) { const e = new Error('no such user'); e.code = 'USER_UNKNOWN'; throw e; }
  if (user.is_active === false) { const e = new Error('account inactive'); e.code = 'USER_INACTIVE'; throw e; }

  // MFA is the portal's to enforce; OFS refuses a ticket that does not assert it
  // for an account that requires it, so this app can never be the weaker door.
  const needsMfa = user.mfa_enabled === true || user.requires_mfa === true;
  if (needsMfa && claims.mfa !== true) {
    const e = new Error('ticket does not assert MFA'); e.code = 'MFA_REQUIRED'; throw e;
  }

  // Single active session, shared with the portal: a newer portal login rotates
  // active_sid, which invalidates this session too.
  if (user.active_sid && claims.sid && claims.sid !== user.active_sid) {
    const e = new Error('session superseded'); e.code = 'SESSION_STALE'; throw e;
  }

  await sso.redeem(claims, req.ip);                 // single-use; throws on replay
  return { user, sid: claims.sid || user.active_sid || null };
}

const FAIL_TEXT = {
  TICKET_EXPIRED: 'That sign-in link has expired. Please open the OFS desk from the portal again.',
  TICKET_REPLAYED: 'That sign-in link has already been used. Please open the OFS desk from the portal again.',
  TICKET_INVALID: 'That sign-in link is not valid.',
  SSO_UNCONFIGURED: 'Single sign-on is not configured on this server.',
  USER_UNKNOWN: 'No matching user account.',
  USER_INACTIVE: 'That account is inactive.',
  MFA_REQUIRED: 'This account requires multi-factor authentication; sign in at the portal first.',
  SESSION_STALE: 'You have signed in elsewhere since. Please open the OFS desk from the portal again.'
};

/** GET /auth/sso?t=<ticket> — the portal redirects the browser here. */
router.get('/sso', ssoLimiter, async (req, res) => {
  const token = req.query.t || req.query.token;
  if (!token) return res.status(400).send(page('Missing sign-in ticket.'));
  try {
    const { user, sid } = await redeemTicket(req, String(token));
    res.cookie(COOKIE, issueSession(user, sid), COOKIE_OPTS);
    await audit.log({ user: { email: user.email, id: user.id }, ip: req.ip },
      'sso_login', 'session', String(user.id), null, { role: user.role });
    // Redirect so the ticket leaves the address bar and the history entry.
    // Staff land on the desk, not the client login page.
    res.redirect('/desk');
  } catch (e) {
    console.warn('[sso] rejected:', e.code || e.message);
    res.status(401).send(page(FAIL_TEXT[e.code] || 'Sign-in failed.'));
  }
});

/** POST /auth/sso/exchange { t } — same thing for a fetch-based caller. */
router.post('/sso/exchange', ssoLimiter, express.json(), async (req, res) => {
  const token = req.body && (req.body.t || req.body.token);
  if (!token) return res.status(400).json({ error: 'missing_ticket' });
  try {
    const { user, sid } = await redeemTicket(req, String(token));
    res.cookie(COOKIE, issueSession(user, sid), COOKIE_OPTS);
    res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
  } catch (e) {
    res.status(401).json({ error: e.code || 'sso_failed', message: FAIL_TEXT[e.code] || 'Sign-in failed.' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, Object.assign({}, COOKIE_OPTS, { maxAge: undefined }));
  res.json({ ok: true });
});

/** Minimal, self-contained failure page — no template engine, CSP-safe. */
function page(message) {
  const esc = String(message).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const portal = process.env.PORTAL_URL || '';
  return `<!doctype html><meta charset="utf-8"><title>OFS Desk — sign in</title>
<body style="font:14px system-ui,sans-serif;background:#0d1117;color:#e6edf6;margin:0;
display:flex;align-items:center;justify-content:center;height:100vh">
<div style="max-width:420px;padding:28px;background:#141a23;border:1px solid #232c3a;border-radius:10px">
<h1 style="font-size:16px;margin:0 0 10px">OFS Desk</h1>
<p style="color:#8b98ab;margin:0 0 16px">${esc}</p>
${portal ? `<a href="${portal}" style="color:#4f8cff">Go to the portal</a>` : ''}
</div></body>`;
}

module.exports = router;
