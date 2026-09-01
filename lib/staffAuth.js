'use strict';
/**
 * Staff (back-office) sign-in rules — no database and no bcrypt import here, so the
 * decisions that matter can be unit-tested on their own.
 *
 * Two doors lead to the desk and they are deliberately different:
 *
 *   portal SSO      the preferred one. The portal has already done password + MFA;
 *                   OFS only redeems a 60s ticket (routes/auth.js).
 *   direct sign-in  this one. Used where the portal patch is not deployed, or where
 *                   a back-office user has no reason to visit the portal at all.
 *                   It re-does the portal's own checks against the SAME accounts —
 *                   OFS never keeps a password of its own.
 *
 * Because the accounts are shared, the direct door must never be the weaker one:
 * an M365 account has no password to check, an inactive account is refused, and a
 * role that demands MFA still gets a one-time code before a session is issued.
 */

const DESK_PAGES = ['ofs-desk', 'ofs-masters'];

/** Direct sign-in is a fallback; a deployment that has SSO can switch it off. */
function directLoginEnabled() {
  return String(process.env.OFS_STAFF_LOGIN || 'true') === 'true';
}

/**
 * May this account use the password door at all?
 * Returns null when it may, or a reason code when it may not. Callers translate the
 * reason into a message; only 'm365' is safe to surface, because it tells an
 * attacker nothing they could not learn by looking at the portal's own login page.
 */
function directLoginBlock(user) {
  if (!user) return 'unknown';
  if (user.is_active === false) return 'inactive';
  if (user.use_m365 === true || user.auth_provider === 'm365') return 'm365';
  if (!user.password_hash) return 'no_password';
  return null;
}

/** The role's own policy, exactly as the portal reads it. */
function needsMfa(user) {
  return user.mfa_enabled === true || user.requires_mfa === true;
}

/** Permissions come out of the roles table as JSONB or as text, depending on driver. */
function pagesOf(permissions) {
  let p = permissions;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
  const pages = p && p.pages;
  return Array.isArray(pages) ? pages.map(String) : [];
}

/**
 * Does this role reach the desk? '*' (SuperAdmin) does. Otherwise an entry for one
 * of the OFS pages does, with or without a ':view'/':edit'/':pii' suffix.
 * A session is not issued to an account that could only stare at an empty gate.
 */
function hasDeskGrant(permissions) {
  return pagesOf(permissions).some((e) => e === '*' || DESK_PAGES.indexOf(e.split(':')[0]) >= 0);
}

module.exports = { DESK_PAGES, directLoginEnabled, directLoginBlock, needsMfa, pagesOf, hasDeskGrant };
