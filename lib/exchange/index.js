'use strict';
const nse = require('./nse');
const bse = require('./bse');

const ADAPTERS = { NSE: nse, BSE: bse };

function adapterFor(exchange) {
  const a = ADAPTERS[String(exchange || '').toUpperCase()];
  if (!a) throw new Error('Unknown exchange: ' + exchange);
  return a;
}

module.exports = { ADAPTERS, adapterFor, nse, bse };
