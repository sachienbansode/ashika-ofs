'use strict';
/**
 * Connection-config building, kept free of any `pg` import so it can be unit
 * tested without a driver or a database.
 *
 * Config precedence per connection: <PREFIX>_DATABASE_URL, else discrete
 * <PREFIX>_PG_* vars. A password given separately as <PREFIX>_PG_PASSWORD always
 * wins over one embedded in the URL, so the URL can be kept password-free.
 */

/** Expand a postgres:// URL into discrete pg options. Components are URL-decoded. */
function fromUrl(url, ssl, max) {
  const u = new URL(url);
  const dec = (v) => (v ? decodeURIComponent(v) : v);
  const cfg = {
    host: dec(u.hostname),
    port: Number(u.port || 5432),
    database: dec(u.pathname.replace(/^\//, '')) || undefined,
    user: dec(u.username) || undefined,
    ssl, max
  };
  if (u.password) cfg.password = dec(u.password);
  // sslmode in the query string, if present, wins over the <PREFIX>_PG_SSL flag.
  const mode = u.searchParams.get('sslmode');
  if (mode === 'disable') cfg.ssl = false;
  else if (mode) cfg.ssl = { rejectUnauthorized: mode === 'verify-full' || mode === 'verify-ca' };
  return cfg;
}

function build(prefix, appName) {
  const url = process.env[prefix + '_DATABASE_URL'];
  const pw = process.env[prefix + '_PG_PASSWORD'];
  const ssl = String(process.env[prefix + '_PG_SSL'] || 'false') === 'true'
    ? { rejectUnauthorized: false } : false;
  const max = Number(process.env[prefix + '_PG_POOL_MAX'] || 10);

  // The URL is expanded here rather than handed to pg as `connectionString`.
  // pg merges a connection string OVER the rest of the config
  // (ConnectionParameters does Object.assign({}, config, parse(connectionString))),
  // so a password supplied alongside a URL is silently overwritten by the URL's
  // own - absent - password, and the server then rejects SCRAM with
  // "client password must be a string". Parsing it ourselves keeps the password
  // out of the URL AND actually reaching the driver.
  const cfg = url ? fromUrl(url, ssl, max) : {
    host: process.env[prefix + '_PG_HOST'],
    port: Number(process.env[prefix + '_PG_PORT'] || 5432),
    database: process.env[prefix + '_PG_DATABASE'],
    user: process.env[prefix + '_PG_USER'],
    ssl, max
  };

  // An explicit <PREFIX>_PG_PASSWORD always wins over one embedded in the URL.
  if (pw) cfg.password = pw;
  if (typeof cfg.password !== 'string' || !cfg.password) delete cfg.password;
  cfg.idleTimeoutMillis = 30000;
  cfg.connectionTimeoutMillis = 10000;
  cfg.application_name = appName;
  return cfg;
}

/** Describes a connection for logs and /readyz WITHOUT leaking credentials. */
function describe(prefix) {
  const url = process.env[prefix + '_DATABASE_URL'];
  if (url) {
    try {
      const u = new URL(url);
      return u.hostname + ':' + (u.port || 5432) + u.pathname;
    } catch (e) { return '<malformed ' + prefix + '_DATABASE_URL>'; }
  }
  return (process.env[prefix + '_PG_HOST'] || '?') + ':' +
         (process.env[prefix + '_PG_PORT'] || 5432) + '/' +
         (process.env[prefix + '_PG_DATABASE'] || '?');
}

module.exports = { build, describe, fromUrl };
