'use strict';
/**
 * Which fields an exchange refresh should actually write. No database import, so
 * the rule that protects desk decisions is testable without a driver.
 *
 * The exchange owns the facts; the desk owns its own decisions. `status` is
 * therefore absent from this list on purpose: if the desk suspended an issue, a
 * refresh must not quietly reopen it.
 */
const EXCHANGE_FIELDS = ['company', 'isin', 'exchange', 'bse_scrip_code', 'floor_price',
  'cut_price_min', 'tick', 'lot', 'issue_qty', 'retail_qty', 'discount_pct',
  'hni_open', 'hni_close', 'ret_open', 'ret_close'];

/** Fields that genuinely differ. A value the source did not supply never blanks one we hold. */
function changed(before, next) {
  return EXCHANGE_FIELDS.filter((f) => {
    if (next[f] == null) return false;
    const a = before[f], b = next[f];
    if (a instanceof Date || /_open$|_close$/.test(f)) {
      return new Date(a).getTime() !== new Date(b).getTime();
    }
    if (a !== null && a !== '' && !isNaN(Number(a)) && !isNaN(Number(b))) {
      return Number(a) !== Number(b);
    }
    return String(a == null ? '' : a) !== String(b);
  });
}

module.exports = { changed, EXCHANGE_FIELDS };
