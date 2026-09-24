'use strict';
/**
 * What a spec sees of the workbook.
 *
 * The same JSON lib/bookSync hands the config, loaded once per worker. Specs ask
 * this for a user or a value rather than reading the file themselves, so a run
 * cannot take two different views of the plan if somebody has it open in Excel.
 */
const { loadSync } = require('./bookSync');

const b = loadSync();

/** The first user of a role, or null. */
function user(role) {
  return b.users.find((u) => String(u.role || '').toLowerCase() === String(role).toLowerCase()) || null;
}

/** A user of this role, or a skip with a message that names the missing column. */
function requireUser(role) {
  const u = user(role);
  if (!u || !u.identifier) {
    throw new Error('No "' + role + '" row with an identifier on the Users sheet of ' + b.file);
  }
  if (role === 'desk' && !u.password) {
    throw new Error('The desk user on the Users sheet has no password. Back-office sign-in is ' +
      'email + password — fill the password column in ' + b.file);
  }
  return u;
}

function value(key, dflt) {
  const r = b.data.find((d) => String(d.key || '').toLowerCase() === String(key).toLowerCase());
  return (r && r.value) || (dflt == null ? '' : dflt);
}

module.exports = {
  file: b.file,
  envName: b.envName,
  env: b.env,
  users: b.users,
  user, requireUser, value,
  /** Writes are off unless the Environment row says otherwise, in words. */
  get writes() { return b.env.writes; }
};
