'use strict';
const nse = require('./nse');
const bse = require('./bse');
const full = require('./fullExport');

/**
 * FULL is not an exchange. It is the desk's own extract — every field including who
 * placed the bid and when — and it is registered here only so the export route can
 * build it through the same path. Nothing sends it to an exchange.
 */
const ADAPTERS = { NSE: nse, BSE: bse, FULL: full };

function adapterFor(exchange) {
  const a = ADAPTERS[String(exchange || '').toUpperCase()];
  if (!a) throw new Error('Unknown exchange: ' + exchange);
  return a;
}

/** Does this target actually reach an exchange? FULL does not. */
function isExchange(name) {
  return ['NSE', 'BSE'].indexOf(String(name || '').toUpperCase()) >= 0;
}

module.exports = { ADAPTERS, adapterFor, isExchange, nse, bse, full };
