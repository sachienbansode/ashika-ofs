'use strict';
/**
 * public/shared/bidmath.js — the bid arithmetic, in ONE place, for all three logins.
 *
 * The desk at /backoffice, a branch or AP at /partner and a client at / are three
 * front ends over one set of rules. /partner already IS the back-office file served
 * twice, so those two can never disagree; the client portal is a separate page, and
 * this is what stops it drifting from them.
 *
 * Nothing here touches the DOM or the network. The same numbers reach the screen in
 * all three places, and the SERVER still recomputes every one of them in
 * lib/domain.js before a bid is accepted — this is a convenience for the person
 * filling the form, never the thing that decides whether a bid is legal.
 *
 * Read as window.OFS_BIDMATH by public/backoffice/app.js and public/client/client.js.
 */
(function (w) {
  /** Rupees, for the one sentence these functions have to write. */
  function rupee(v, dp) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return '₹' + n.toLocaleString('en-IN', {
      minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp
    });
  }

  /**
   * The lowest price this category may bid.
   *
   * Retail has its own cut-off minimum when the seller published one; otherwise both
   * categories sit on the floor. An undisclosed floor is null, not zero — a zero
   * floor would make every bid look valid and every quantity infinite.
   */
  function minPriceFor(issue, category) {
    if (!issue) return null;
    var floor = issue.floor_price == null || issue.floor_price === '' ? null : Number(issue.floor_price);
    if (category === 'Retail') {
      var cm = issue.cut_price_min == null || issue.cut_price_min === '' ? null : Number(issue.cut_price_min);
      if (cm != null && cm > 0) return cm;
    }
    return floor != null && floor > 0 ? floor : null;
  }

  /** The smallest quantity that clears the non-retail minimum, rounded up to a lot. */
  function minQtyFor(issue, category, price, cfg) {
    var lot = Number(issue && issue.lot) || 1;
    if (category !== 'HNI') return lot;
    var p = Number(price) || minPriceFor(issue, category);
    var floorValue = Number((cfg || {}).hni_min || 200000);
    if (!p || !floorValue) return lot;
    return Math.max(lot, Math.ceil(Math.ceil(floorValue / p) / lot) * lot);
  }

  /** The largest quantity that still fits under the retail cap at this price. */
  function maxRetailQty(issue, price, cfg) {
    var lot = Number(issue && issue.lot) || 1;
    var p = Number(price) || minPriceFor(issue, 'Retail');
    var cap = Number((cfg || {}).retail_cap || 200000);
    if (!p) return null;
    return Math.max(0, Math.floor(Math.floor(cap / p) / lot) * lot);
  }

  /**
   * A bid worth offering, and the sentence explaining it.
   *
   * Retail: the cap is on VALUE, so a higher price buys fewer shares — the lowest
   * allowed price is the one that fits the most in. HNI: the minimum price and the
   * smallest quantity that clears the non-retail minimum, which is the cheapest way
   * to be a valid non-retail bid.
   *
   * Returns null when there is nothing honest to suggest, which is the case an
   * undisclosed floor produces.
   */
  function suggestedBid(issue, category, cfg) {
    var mp = minPriceFor(issue, category);
    if (!issue || mp == null) return null;
    var tick = Number(issue.tick) || 0.05;
    if (category === 'HNI') {
      return { price: mp, qty: minQtyFor(issue, 'HNI', mp, cfg),
               why: 'HNI: the minimum price, and the smallest quantity that clears the non-retail minimum.' };
    }
    var rp = Math.round(mp / tick) * tick;
    return { price: Number(rp.toFixed(2)), qty: maxRetailQty(issue, rp, cfg),
             why: 'Retail: the lowest allowed price, and the largest quantity that still fits under the ' +
                  rupee(Number((cfg || {}).retail_cap || 200000), 0) + ' cap.' };
  }

  /**
   * Which exchange a bid should default to.
   *
   * An issue on one exchange has nothing to choose. On BOTH somebody must choose,
   * because a bid that reached neither file would not be submitted and one that
   * reached both would be submitted twice — so the form picks BSE rather than
   * leaving it blank and refusing on validate. BSE is the default because it is
   * where Ashika's OFS flow runs today; the desk can still change it per bid.
   */
  var DEFAULT_EXCHANGE = 'BSE';
  function defaultExchange(issue) {
    var e = String((issue && issue.exchange) || '').trim().toUpperCase();
    if (e === 'NSE' || e === 'BSE') return e;
    return e === 'BOTH' ? DEFAULT_EXCHANGE : '';
  }

  w.OFS_BIDMATH = {
    minPriceFor: minPriceFor, minQtyFor: minQtyFor, maxRetailQty: maxRetailQty,
    suggestedBid: suggestedBid, defaultExchange: defaultExchange,
    DEFAULT_EXCHANGE: DEFAULT_EXCHANGE
  };
}(window));
