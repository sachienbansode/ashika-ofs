'use strict';
/** Shared fixtures: one OFS issue plus the desk settings, as the DB would return them. */

const ISSUE = {
  id: 1, symbol: 'COALINDIA', company: 'Coal India Ltd', isin: 'INE522F01014',
  series: 'EQ', exchange: 'BOTH', bse_scrip_code: '533278',
  floor_price: 385, cut_price_min: 386, tick: 0.05, lot: 1,
  issue_qty: 50000000, retail_qty: 5000000, discount_pct: 5,
  cutoff_flag: true, status: 'Auto',
  hni_open: '2026-09-01T09:15:00+05:30', hni_close: '2026-09-01T15:15:00+05:30',
  ret_open: '2026-09-02T09:15:00+05:30', ret_close: '2026-09-02T15:15:00+05:30'
};

const SETTINGS = {
  retail_cap: 200000, hni_min: 200000, enforce_margin: 1, daily_cutoff: '15:15',
  margin_type: 2, cat_retail: 'RI', cat_retail_cutoff: 'RIC', cat_hni: 'NII',
  cutoff_price_mode: 'zero'
};

const T_DAY_11AM  = new Date('2026-09-01T11:00:00+05:30');   // HNI window open
const T1_DAY_11AM = new Date('2026-09-02T11:00:00+05:30');   // Retail window open

function ctx(over) {
  return Object.assign({
    settings: SETTINGS, availableMargin: 1e7, marginUsed: 0,
    usedValueThisIssue: 0, hasLiveBid: false, now: T_DAY_11AM
  }, over || {});
}

module.exports = { ISSUE, SETTINGS, T_DAY_11AM, T1_DAY_11AM, ctx };
