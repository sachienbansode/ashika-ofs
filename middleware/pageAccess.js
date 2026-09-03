'use strict';
/**
 * pageAccess - mirrors middleware/pageAccess.js (REUSE.md 2, 7).
 * Invariants: full access is '*' ONLY; every route mount is gated; PII unmask is
 * an explicit gated toggle that fails closed.
 *
 * A permission entry is either '*', a page key ('ofs-desk'), or 'key:level'
 * where level is view | edit | pii.
 */
const LEVELS = { view: 1, edit: 2, pii: 3 };

/**
 * The OFS module is granted whole, not page by page.
 *
 * Ashika's rule: whoever has access to OFS has FULL access to OFS. So any grant on
 * any OFS page — at any level, including a bare key — confers edit and PII on every
 * OFS page. There is no read-only OFS user and no half-open OFS user; the levels
 * below still apply to every non-OFS page, where the platform sets them.
 *
 * Worth being explicit about what this includes: PII. An account with `ofs-desk`
 * sees unmasked PAN and mobile in the bid book. The control is therefore who holds
 * the OFS grant at all, not what level it carries — the Admin console is where that
 * decision is made, and `docs/sql/ofs_backoffice_role.sql` is where it is applied.
 */
const MODULE_PAGES = ['ofs-desk', 'ofs-masters'];

function entries(req) {
  const p = (req.user && req.user.permissions && req.user.permissions.pages) || [];
  return Array.isArray(p) ? p.map(String) : [];
}

function isFullAccess(req) {
  return entries(req).some((e) => e === '*');
}

/** Does this account hold any OFS grant at all? */
function hasModuleAccess(req) {
  return entries(req).some((e) => MODULE_PAGES.indexOf(e.split(':')[0]) >= 0);
}

function levelFor(req, key) {
  if (isFullAccess(req)) return LEVELS.pii;
  // Whoever is in the module is all the way in. See MODULE_PAGES above.
  if (MODULE_PAGES.indexOf(key) >= 0 && hasModuleAccess(req)) return LEVELS.pii;
  let best = 0;
  for (const e of entries(req)) {
    const [k, lv] = e.split(':');
    if (k !== key) continue;
    best = Math.max(best, LEVELS[String(lv || 'view').toLowerCase()] || LEVELS.view);
  }
  return best;
}

function requirePage(...keys) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    const ok = keys.some((k) => levelFor(req, k) >= LEVELS.view);
    if (!ok) return res.status(403).json({ error: 'forbidden', page: keys[0] });
    req.pageKey = keys.find((k) => levelFor(req, k) >= LEVELS.view);
    next();
  };
}

function requireEdit(key) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (levelFor(req, key) < LEVELS.edit) return res.status(403).json({ error: 'read_only', page: key });
    next();
  };
}

/** Fail-closed: no explicit pii grant => masked. */
function canViewPII(req, key) {
  return levelFor(req, key || req.pageKey) >= LEVELS.pii;
}

function requirePII(key) {
  return function (req, res, next) {
    if (!canViewPII(req, key)) return res.status(403).json({ error: 'pii_forbidden', page: key });
    next();
  };
}

module.exports = {
  LEVELS, MODULE_PAGES, requirePage, requireEdit, isFullAccess, hasModuleAccess,
  levelFor, canViewPII, requirePII
};
