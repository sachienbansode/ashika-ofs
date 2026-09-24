'use strict';
/**
 * The QA console's own door.
 *
 * Its own, deliberately — this console is not part of the OFS app, shares no
 * database with it, and must never be a second way into it. A single operator
 * account, a bcrypt hash and a signed cookie is the whole of it.
 *
 * The hash lives in qa/.env, never a password, and `npm run set-password`
 * writes it. Two reasons that matters here rather than being a nicety: this
 * console can upload a file and start a process, and the plan workbooks it
 * stores carry the credentials for all three OFS roles. A weak door on this is
 * a strong door on nothing.
 *
 * No session store. The cookie IS the session: user and expiry, signed with a
 * secret, verified with a constant-time compare. Nothing to clean up, nothing
 * to lose on restart, and no list of live sessions to leak.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const USER = process.env.OFS_QA_USER || 'qa';
const HASH = process.env.OFS_QA_PASSWORD_HASH || '';
const SECRET = process.env.OFS_QA_SECRET || '';
const HOURS = Number(process.env.OFS_QA_SESSION_HOURS || 8);
const COOKIE = 'ofsqa';

/* A dummy to compare against when the account does not exist, so a wrong user
 * and a wrong password take the same time. Without it the door answers "no such
 * user" in a millisecond and "wrong password" in eighty. */
const DUMMY = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function configured() { return !!(HASH && SECRET); }

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function issue(res, user) {
  const exp = Date.now() + HOURS * 3600000;
  const body = Buffer.from(JSON.stringify({ u: user, e: exp })).toString('base64url');
  const token = body + '.' + sign(body);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Behind nginx with TLS this must be set; on plain http in a lab it cannot
    // be, or the browser drops the cookie and the door appears broken.
    secure: String(process.env.OFS_QA_COOKIE_SECURE || '') === 'true',
    maxAge: HOURS * 3600000
  });
}

function read(req) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw || !SECRET) return null;
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const body = raw.slice(0, i), mac = raw.slice(i + 1);
  const want = sign(body);
  // Equal length first: timingSafeEqual throws on a mismatch, and a throw is
  // itself a signal.
  if (mac.length !== want.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!o || !o.e || Date.now() > o.e) return null;
    return { user: o.u };
  } catch (e) { return null; }
}

async function check(user, password) {
  const known = String(user || '') === USER;
  // Always spend the round, even when the user is wrong.
  const ok = await bcrypt.compare(String(password || ''), known && HASH ? HASH : DUMMY);
  return known && ok;
}

/** Guard for a page: send them to the door. */
function requirePage(req, res, next) {
  const s = read(req);
  if (!s) return res.redirect('/login');
  req.qa = s;
  next();
}

/** Guard for an endpoint: say no, do not redirect a fetch into an HTML page. */
function requireApi(req, res, next) {
  const s = read(req);
  if (!s) return res.status(401).json({ error: 'unauthenticated' });
  req.qa = s;
  next();
}

function clear(res) { res.clearCookie(COOKIE); }

module.exports = { USER, COOKIE, configured, issue, read, check, requirePage, requireApi, clear };
