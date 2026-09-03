'use strict';
const { SCHEMA, query } = require('../db/ofsAdapter');

function ip(req) {
  const raw = (req && (req.ip || (req.connection && req.connection.remoteAddress))) || '';
  const m = String(raw).match(/(\d{1,3}\.){3}\d{1,3}|[0-9a-f:]{3,}/i);
  return m ? m[0] : null;
}

/**
 * Who did this. A client session is not a platform user — it has no req.user — and
 * before this every client action would have been recorded as 'system', which is
 * the one thing an audit trail must never say about a person's own bid.
 */
function actorOf(req) {
  if (req && req.user && (req.user.email || req.user.id)) return String(req.user.email || req.user.id);
  if (req && req.client && req.client.ucc) {
    return req.client.actorType === 'ap' && req.client.apId
      ? 'ap:' + req.client.apId + ' for ' + req.client.ucc
      : 'client:' + req.client.ucc;
  }
  return 'system';
}

async function log(req, action, entity, entityId, before, after) {
  try {
    await query(
      `INSERT INTO ${SCHEMA}.ofs_audit (actor, action, entity, entity_id, before, after, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        actorOf(req),
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

module.exports = { log, actorOf };
