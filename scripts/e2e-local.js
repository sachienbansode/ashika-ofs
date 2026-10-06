'use strict';
/**
 * The end-to-end suite, against a PostgreSQL that this script brings with it.
 *
 * e2e/run.js drives the real server over HTTP against two real databases, and it
 * is the only thing here that would have caught a route that throws the moment it
 * is called — `node --check` parses, and the unit tests read source. It had stopped
 * being run for one reason: there was no PostgreSQL within reach of the machine
 * doing the work, and standing one up was somebody's manual job.
 *
 * So the suite carries its own. embedded-postgres ships real server binaries;
 * this starts one on a scratch directory, creates both databases, applies the
 * migrations and the LD-shaped fixtures, boots the app, runs every scenario and
 * tears the lot down. Nothing is left behind and nothing outside this directory
 * is touched.
 *
 *     npm run e2e
 *
 * It is a DEV dependency: a deploy that installs with --omit=dev never sees it.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT_DB = Number(process.env.E2E_PG_PORT) || 55445;
const PORT_APP = Number(process.env.E2E_PORT) || 3199;
const ROOT = path.join(__dirname, '..');
const DATA = path.join(os.tmpdir(), 'ofs-e2e-pg-' + process.pid);
const SOCK = os.tmpdir();

let EmbeddedPostgres;
try {
  const m = require('embedded-postgres');
  EmbeddedPostgres = m.default || m;
} catch (e) {
  console.error('embedded-postgres is not installed. Run:  npm i -D embedded-postgres');
  process.exit(1);
}

/* The app reads these; e2e/env.example is the same list, kept in step with it.
 * NODE_ENV is 'test' and not 'production' on purpose: the confirmation code has
 * to come back in the response for the bid path to run without SMTP, and that
 * mode is hard-floored off in production — scenario PRD-1 proves it. */
const ENV = Object.assign({}, process.env, {
  NODE_ENV: 'test',
  PORT: String(PORT_APP),
  OFS_PG_HOST: SOCK, OFS_PG_PORT: String(PORT_DB),
  OFS_PG_DATABASE: 'ofs_bids', OFS_PG_USER: 'ofsapp',
  ANANTA_PG_HOST: SOCK, ANANTA_PG_PORT: String(PORT_DB),
  ANANTA_PG_DATABASE: 'uat_ananta_staging', ANANTA_PG_USER: 'ofsapp',
  JWT_SECRET: 'e2e-only-not-a-real-secret-0123456789',
  JWT_ISSUER: 'omnenest-staging-api',
  CLIENT_JWT_SECRET: 'e2e-only-client-secret-9876543210',
  COOKIE_SECURE: 'false',
  APP_URL: 'http://localhost:' + PORT_APP,
  OFS_OTP_TEST_MODE: 'true',
  // The password never reaches a command line or a DSN, here or anywhere else.
  PGPASSWORD: 'e2e-local-only'
});

const run = (cmd, args, opts) => new Promise((ok, no) => {
  const p = spawn(cmd, args, Object.assign({ cwd: ROOT, env: ENV, stdio: 'inherit' }, opts || {}));
  p.on('exit', (c) => (c === 0 ? ok() : no(new Error(cmd + ' exited ' + c))));
  p.on('error', no);
});

async function waitForApp(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch('http://localhost:' + PORT_APP + '/healthz');
      if (r.status < 500) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the server did not answer on port ' + PORT_APP);
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA, user: 'ofsapp', password: ENV.PGPASSWORD,
    port: PORT_DB, persistent: false, onLog: () => {}
  });

  console.log('starting a scratch PostgreSQL on port ' + PORT_DB);
  await pg.initialise();
  // Unix socket in the temp dir, which is what e2e/env.example points the app at.
  fs.appendFileSync(path.join(DATA, 'postgresql.conf'),
    "\nunix_socket_directories = '" + SOCK + "'\n");
  await pg.start();

  let app = null;
  try {
    await pg.createDatabase('ofs_bids');
    await pg.createDatabase('uat_ananta_staging');

    console.log('applying migrations');
    await run(process.execPath, ['db/migrate.js']);

    console.log('seeding the client-master fixtures');
    /* A client built for THIS database by hand. pg.getPgClient() hands back one
       pointed at the server's default database and setting .database on it after
       the fact does nothing — the fixtures went in silently next door, and the
       app then started against a client master with no tables in it. */
    const { Client } = require('pg');
    const seed = new Client({ host: SOCK, port: PORT_DB, user: 'ofsapp',
      password: ENV.PGPASSWORD, database: 'uat_ananta_staging' });
    await seed.connect();
    await seed.query(fs.readFileSync(path.join(ROOT, 'e2e', 'fixtures.sql'), 'utf8'));
    await seed.end();

    console.log('starting the app on port ' + PORT_APP);
    app = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: ENV, stdio: 'inherit' });
    await waitForApp(30000);

    console.log('running the scenarios\n');
    await run(process.execPath, ['e2e/run.js'], { env: Object.assign({}, ENV,
      { E2E_BASE: 'http://localhost:' + PORT_APP }) });
  } finally {
    if (app) app.kill('SIGTERM');
    await pg.stop().catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n' + e.message); process.exit(1); });
