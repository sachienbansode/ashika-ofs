'use strict';
const { SCHEMA, query } = require('../db/ofsAdapter');

function ip(req) {
  const raw = (req && (req.ip || (req.connection && req.connection.remoteAddress))) || '';
  const m = String(raw).match(/(\d{1,3}\.){3}\d{1,3}|[0-9a-f:]{3,}/i);
  return m ? m[0] : null;
}

async function log(req, action, entity, entityId, before, after) {
  try {
    await query(
      `INSERT INTO ${SCHEMA}.ofs_audit (actor, action, entity, entity_id, before, after, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        (req && req.user && (req.user.email || req.user.id)) || 'system',
        action, entity, entityId == null ? null : String(entityId),
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        ip(req)
      ]
    );
  } catch (e) {
    console.error('[audit] write failed:', e.message);   // never block the action
  }
}

module.exports = { log };
