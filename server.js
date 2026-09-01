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
const settings = require('./lib/settings');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---- security headers (CSP on; no inline/external script) ---- */
app.use(helmet({
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
      formAction: ["'self'"]
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
app.get('/readyz', async (req, res) => {
  try { await ofsDb.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

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

/* ---- static desk UI ---- */
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '5m' }));

app.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, next) => {           // eslint-disable-line no-unused-vars
  console.error('[error]', err.stack || err.message);
  res.status(err.status || 500).json({ error: 'server_error' });
});

const PORT = Number(process.env.PORT || 4011);
const HOST = process.env.HOST || '127.0.0.1';   // bound to localhost; nginx in front

async function start() {
  try { console.log('[boot] pages registered:', (await registerPages()).join(', ')); }
  catch (e) { console.warn('[boot] page registration skipped:', e.message); }
  app.listen(PORT, HOST, () => console.log(`[boot] ashika-ofs-app listening on ${HOST}:${PORT}`));
}

if (require.main === module) start();
module.exports = { app, start };
