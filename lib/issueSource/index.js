'use strict';
/**
 * Which source answers for an exchange, and why.
 *
 * NSE has two possible sources and they are not equal:
 *
 *   e-OFS Web API   sanctioned, structured, complete. Needs credentials NSE issues
 *                   to the member (docs/NSE_API_REQUEST.md). Used whenever it is
 *                   configured — it is strictly better than the alternative.
 *   web scraping    prohibited by NSE's terms AND non-functional (the public paths
 *                   404). Off by default and should stay off.
 *
 * BSE has neither: no API is published, and its pages return 403 to anything that is
 * not a browser. The working path there is the T-2/T-1 member notice, imported as
 * CSV, and that is what the desk is told.
 *
 * The circular watch (lib/circularWatch.js) runs on its own schedule and is the one
 * automatic route that works today — it cannot give structured floor prices, but it
 * guarantees the desk knows an OFS exists.
 */
const bse = require('./bse');
const nse = require('./nse');
const eofs = require('./eofs');

const SOURCES = { BSE: bse, NSE: nse };

/**
 * The best available source for an exchange, right now.
 * `.chosen` says which and why, so the pull log can report it instead of the desk
 * guessing why one exchange behaved differently from the other.
 */
function sourceFor(exchange) {
  const key = String(exchange || '').toUpperCase();
  if (key === 'NSE' && eofs.configured()) {
    return Object.assign(Object.create(eofs), {
      chosen: 'e-OFS Web API (credentials configured)'
    });
  }
  const s = SOURCES[key];
  if (!s) throw new Error('Unknown issue source: ' + exchange);
  return Object.assign(Object.create(s), {
    chosen: key === 'NSE'
      ? 'public web (e-OFS credentials not configured)'
      : 'public web (BSE publishes no API)'
  });
}

/** What each exchange can actually do today — for the desk, not for the log. */
function capability(exchange) {
  const key = String(exchange || '').toUpperCase();
  if (key === 'NSE') {
    return eofs.configured()
      ? { level: 'api', label: 'e-OFS Web API',
          detail: 'Issue master fetched directly from NSE.' }
      : { level: 'none', label: 'Not available yet',
          detail: 'NSE publishes no usable public feed, and its terms prohibit scraping. '
                + 'The fix is e-OFS API credentials from NSE — until then the circular watch '
                + 'creates a provisional issue for each OFS, and the T-2/T-1 member notice '
                + 'can be imported as CSV.' };
  }
  return { level: 'none', label: 'Not available',
    detail: 'BSE publishes no OFS API, and its pages refuse non-browser clients. '
          + 'Import the T-2/T-1 member notice under Masters → Import issues CSV.' };
}

module.exports = { SOURCES, sourceFor, capability, bse, nse, eofs };
