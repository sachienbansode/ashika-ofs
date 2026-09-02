'use strict';
/**
 * The back office moved from /desk to /backoffice. Old bookmarks, the portal's OFS
 * link and any deployed copy of the SSO patch still point at /desk, so the old path
 * redirects rather than 404ing someone mid-bidding-window.
 *
 * Pure, so the awkward parts are testable: the bare /desk with no trailing slash,
 * a query string that must survive (?reason=superseded), and the fact that nothing
 * outside the /desk prefix may ever be rewritten.
 */
const DESK_RE = /^\/desk(\/.*)?$/;

/** Returns the new URL, or null when this path is not a legacy one. */
function backofficeRedirect(originalUrl) {
  const url = String(originalUrl || '');
  const q = url.indexOf('?');
  const pathOnly = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q) : '';

  const m = DESK_RE.exec(pathOnly);
  if (!m) return null;
  return '/backoffice' + (m[1] || '/') + query;
}

module.exports = { DESK_RE, backofficeRedirect };
