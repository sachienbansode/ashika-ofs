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

  /**
   * Which exchanges this desk is live on, from the desk's own setting.
   *
   * NSE e-OFS and the BSE OFS module are separate enablements and either can be
   * pending, so the back office says which are usable. This MIRRORS
   * lib/domain.allowedExchanges — deliberately, and a test compares the two against
   * the same inputs. An unreadable or absent value means both, because a setting
   * nobody has touched must not be the thing that silently stops trading.
   */
  function allowedExchanges(cfg) {
    var raw = String((cfg || {}).allowed_exchanges || '').toUpperCase();
    var out = [];
    raw.split(/[^A-Z]+/).forEach(function (x) {
      if ((x === 'NSE' || x === 'BSE') && out.indexOf(x) < 0) out.push(x);
    });
    return out.length ? out : ['NSE', 'BSE'];
  }

  /** Where a bid on THIS issue may go: where it is listed, narrowed by where we are live. */
  function exchangesFor(issue, cfg) {
    var on = String((issue && issue.exchange) || '').trim().toUpperCase();
    var listed = on === 'BOTH' ? ['NSE', 'BSE'] : (on === 'NSE' || on === 'BSE') ? [on] : [];
    var ok = allowedExchanges(cfg);
    return listed.filter(function (x) { return ok.indexOf(x) >= 0; });
  }

  /** Can a bid be placed on this issue at all? */
  function issueTradable(issue, cfg) { return exchangesFor(issue, cfg).length > 0; }

  /** Why not, in words a client can read. No internal names. */
  function notTradableMessage(issue, cfg) {
    if (issueTradable(issue, cfg)) return '';
    var on = String((issue && issue.exchange) || '').trim().toUpperCase();
    var sym = (issue && issue.symbol) || 'This offer';
    if (!on) return sym + ' has no exchange set yet, so bids cannot be accepted for it.';
    return sym + ' is offered on ' + on + ' only, and bids are not being accepted on ' +
      on + ' at present. Please contact the OFS desk.';
  }

  /**
   * Which exchange the form should start on.
   *
   * One usable exchange means there is nothing to choose and the form says so.
   * Two means somebody must choose, because a bid that reached neither file would
   * not be submitted and one that reached both would be submitted twice — so the
   * form picks BSE rather than leaving it blank and refusing on validate. The desk
   * can still change it per bid.
   */
  function defaultExchange(issue, cfg) {
    var usable = exchangesFor(issue, cfg);
    if (!usable.length) return '';
    if (usable.length === 1) return usable[0];
    return usable.indexOf(DEFAULT_EXCHANGE) >= 0 ? DEFAULT_EXCHANGE : usable[0];
  }

  w.OFS_BIDMATH = {
    minPriceFor: minPriceFor, minQtyFor: minQtyFor, maxRetailQty: maxRetailQty,
    suggestedBid: suggestedBid, defaultExchange: defaultExchange,
    allowedExchanges: allowedExchanges, exchangesFor: exchangesFor,
    issueTradable: issueTradable, notTradableMessage: notTradableMessage,
    DEFAULT_EXCHANGE: DEFAULT_EXCHANGE
  };
}(window));
