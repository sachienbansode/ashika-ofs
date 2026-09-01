'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { authMiddleware } = require('./middleware/auth');
const { requirePage } = require('./middleware/pageAccess');
const { registerPages } = require('./lib/pageRegistry');
const ofsDb = require('./db/ofsAdapter');
const ananta = require('./db/anantaAdapter');
const settings = require('./lib/settings');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/*
 * Are we actually being served over TLS? Two CSP/HSTS features are actively
 * harmful when we are not:
 *   upgrade-insecure-requests — the browser rewrites every asset request to
 *     https://, which on a plain-http deployment goes nowhere. The HTML loads and
 *     every stylesheet and script silently fails, while curl (which does not
 *     enforce CSP) reports 200 for all of them.
 *   HSTS — pins the browser to https for the host.
 * Both are switched on the moment the desk is behind a certificate.
 */
const TLS = String(process.env.FORCE_HTTPS || process.env.COOKIE_SECURE || 'false') === 'true';

/* ---- security headers (CSP on; no inline/external script) ---- */
app.use(helmet({
  hsts: TLS,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      // null removes helmet's default; [] enables it once TLS is on.
      upgradeInsecureRequests: TLS ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' }
}));

/* ---- CORS: explicit allow-list, never reflect the request origin ---- */
const ALLOWED = String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOWED.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(o && ALLOWED.includes(o) ? 204 : 403);
  next();
});

app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/* ---- rate limits ---- */
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

app.get('/healthz', (req, res) => res.json({ ok: true, app: process.env.APP_NAME || 'ashika-ofs-app' }));
/** Both databases must answer - the desk is useless with either one down. */
app.get('/readyz', async (req, res) => {
  const out = { ok: true, ofs: null, ananta: null };
  for (const [key, db] of [['ofs', ofsDb], ['ananta', ananta]]) {
    try { await db.query('SELECT 1'); out[key] = { ok: true, target: db.label() }; }
    catch (e) { out.ok = false; out[key] = { ok: false, target: db.label(), error: e.message }; }
  }
  res.status(out.ok ? 200 : 503).json(out);
});

/* ---- session endpoints: deliberately BEFORE authMiddleware ---- */
app.use('/auth', require('./routes/auth'));                 // staff, via portal SSO
app.use('/client/auth', apiLimiter, require('./routes/clientAuth'));   // clients, mobile + email + OTP

/* ---- the client's own view: gated by requireClient inside the router, NOT by
   requirePage. A client is not a platform user and holds no page grants. ---- */
app.use('/client/api', apiLimiter, require('./routes/clientPortal'));

/* ---- API: authenticated, and every mount gated with requirePage ---- */
const api = express.Router();
api.use(apiLimiter, authMiddleware);
api.use(['/bids', '/issues', '/margin', '/allotment'], (req, res, next) =>
  (req.method === 'GET' ? next() : writeLimiter(req, res, next)));

api.get('/me', (req, res) => res.json({
  user: { id: req.user.id, email: req.user.email, role: req.user.role },
  permissions: req.user.permissions
}));
api.get('/settings', requirePage('ofs-desk', 'ofs-masters'), async (req, res, next) => {
  try { res.json({ settings: await settings.all() }); } catch (e) { next(e); }
});

api.use('/dashboard', require('./routes/dashboard'));
api.use('/issues',    require('./routes/issues'));
api.use('/bids',      require('./routes/bids'));
api.use('/clients',   require('./routes/clients'));
api.use('/margin',    require('./routes/margin'));
api.use('/export',    require('./routes/export'));
api.use('/allotment', require('./routes/allotment'));

app.use('/api', api);

/* ---- runtime config for the SPA ----
   Served as a script rather than inlined, because the CSP allows 'self' scripts
   only. Public values only: never put a secret here. */
app.get('/config.js', (req, res) => {
  const cfg = {
    OFS_PORTAL_URL: process.env.PORTAL_URL || '',
    OFS_APP_NAME: process.env.APP_NAME || 'ashika-ofs-app'
  };
  res.type('application/javascript').set('Cache-Control', 'no-store');
  res.send(Object.keys(cfg).map((k) => 'window.' + k + ' = ' + JSON.stringify(cfg[k]) + ';').join('\n'));
});

/* ---- two front ends, deliberately separate ----
   /      the client journey (public: anyone with a UCC can reach it)
   /desk  the OFS team's desk (portal SSO, ofs-desk grant)
   Separate directories so a client-facing page can never accidentally include a
   desk script, and so the desk can later be restricted by IP without touching
   the client side. */
/*
 * Caching: HTML is revalidated on every load, assets are cached but must revalidate.
 * Without this a deploy leaves a browser holding yesterday's index.html while the
 * server serves today's assets - the page renders unstyled and scriptless, with
 * every asset returning 200 to curl. Cost is one conditional request per load.
 */
const STATIC = {
  index: 'index.html',
  etag: true,
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', filePath.endsWith('.html')
      ? 'no-cache'                      // always revalidate the shell
      : 'public, max-age=300, must-revalidate');
  }
};
app.use('/shared', express.static(path.join(__dirname, 'public', 'shared'), STATIC));
app.use('/desk', express.static(path.join(__dirname, 'public', 'desk'), STATIC));
app.use('/', express.static(path.join(__dirname, 'public', 'client'), STATIC));

app.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, next) => {           // eslint-disable-line no-unused-vars
  console.error('[error]', err.stack || err.message);
  res.status(err.status || 500).json({ error: 'server_error' });
});

const PORT = Number(process.env.PORT || 4011);
const HOST = process.env.HOST || '127.0.0.1';   // bound to localhost; nginx in front

async function start() {
  console.log('[boot] ofs db    :', ofsDb.label());
  console.log('[boot] ananta db :', ananta.label());
  try { console.log('[boot] pages registered:', (await registerPages()).join(', ')); }
  catch (e) {
    // Not fatal - the app still serves - but nobody can be granted the page, so
    // say so plainly rather than leaving a one-line warning to be scrolled past.
    console.error('[boot] PAGE REGISTRATION FAILED:', e.message);
    console.error('[boot] the desk will show "ofs-desk grant required" until this is fixed');
  }
  app.listen(PORT, HOST, () => console.log(`[boot] ashika-ofs-app listening on ${HOST}:${PORT}`));
}

if (require.main === module) start();
module.exports = { app, start };
