'use strict';
/**
 * Platform meta DB (users, roles, page_registry, app_settings). Lives in the
 * Ananta database, NOT in ofs_bids — so it rides the Ananta pool.
 */
const ananta = require('./anantaAdapter');

const SCHEMA = ananta.ADMIN;
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const T = (name) => q(SCHEMA) + '.' + q(name);

module.exports = {
  SCHEMA, T,
  adminQuery: ananta.query,
  adminRows: ananta.rows,
  adminOne: ananta.one
};
