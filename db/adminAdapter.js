'use strict';
/**
 * adminAdapter - reads the platform meta DB (users, roles, page_registry, app_settings).
 * Mirrors db/adminAdapter.js in omnenest-uploader-api (REUSE.md 2). Same physical
 * instance, different schema, so it reuses the OFS pool.
 */
const { query } = require('./ofsAdapter');

const SCHEMA = process.env.ADMIN_SCHEMA || 'admin-staging-api';
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const T = (name) => q(SCHEMA) + '.' + q(name);

async function adminQuery(sql, params) { return query(sql, params); }
async function adminRows(sql, params) { return (await query(sql, params)).rows; }
async function adminOne(sql, params) { return (await query(sql, params)).rows[0] || null; }

module.exports = { SCHEMA, T, adminQuery, adminRows, adminOne };
