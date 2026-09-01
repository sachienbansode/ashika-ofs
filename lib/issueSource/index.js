'use strict';
const bse = require('./bse');
const nse = require('./nse');

const SOURCES = { BSE: bse, NSE: nse };

function sourceFor(exchange) {
  const s = SOURCES[String(exchange || '').toUpperCase()];
  if (!s) throw new Error('Unknown issue source: ' + exchange);
  return s;
}

module.exports = { SOURCES, sourceFor, bse, nse };
