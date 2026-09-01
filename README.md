# Ashika OFS — Phase 1

Separate OFS application: OFS-desk role, real-time bidding dashboard, and one-click
NSE / BSE bid-file download. Reuses the `omnenest-uploader-api` platform for LD data,
DB, auth/roles, email and PII — see `REUSE.md`. Full spec: `Ashika_OFS_Module_Specification.docx`.

## Layout
### Two databases

Both live on `13.233.106.37`. Postgres cannot join across databases, so client
identity is fetched from Ananta and merged in the app — never copied into `ofs_bids`.

| Database | Holds | Adapter | Env prefix |
|---|---|---|---|
| `ofs_bids` | OFS state (schema `ofs`) | `db/ofsAdapter.js` | `OFS_` |
| `uat_ananta_staging` — **production** | `dwh`, `stg`, `"admin-staging-api"` | `db/anantaAdapter.js` | `ANANTA_` |

```
db/pool.js              pool factory: <PREFIX>_DATABASE_URL or <PREFIX>_PG_* vars
db/ofsAdapter.js        ofs_bids pool, SCHEMA='ofs'
db/anantaAdapter.js     uat_ananta_staging pool (LD read + page_registry write)
db/ldAdapter.js         client lookups: findByUcc / findMany / search / exists / enrich
db/adminAdapter.js      "admin-staging-api" (users, roles, page_registry) on the Ananta pool
db/smoke.js             npm run smoke - proves both connections and the LD columns
scripts/check-env.js    npm run check-env - validates .env before anything connects
deploy/nginx/ofs.conf   nginx server block (own block; never co-hosted)
db/migrations/001_*.sql ofs schema: setting, issue, bid, margin(+log), allotment, export_log, audit
lib/domain.js           SEBI/exchange bid rules ported from the prototype (server-side truth)
lib/exchange/nse.js     NSE e-OFS bulk-upload mapping      <- pin columns from the member circular
lib/exchange/bse.js     BSE iBBS bulk-bid mapping          <- pin columns from BSE Notice 20120727-26
lib/pii.js              mask mobile/email/PAN/Aadhaar
lib/pageRegistry.js     self-registers pages: ofs-desk, ofs-masters
middleware/auth.js      JWT identity + live role/perm load each request
middleware/pageAccess.js requirePage / requireEdit / canViewPII ('*' = full access only)
routes/                 dashboard, issues, bids, clients, margin, export, allotment
public/shared/          theme.css - one design system for both front ends
public/client/          the client journey: sign-in, open issues, my bids, allotments
public/desk/            the OFS team's desk (CSP-safe: no inline script, no CDN, no chart lib)
tests/                  node --test: domain rules, NSE/BSE adapters, CSV parser
```

## Run
```bash
cp .env.example .env         # fill both DB connections, JWT_SECRET, API_KEY_SECRET, CORS_ORIGINS
npm install
npm run check-env            # missing or placeholder values, before anything connects
npm run smoke                # verify both databases and the LD tables BEFORE migrating
npm run migrate              # applies db/migrations/*.sql to ofs_bids, tracked in ofs._migration
npm start                    # binds 127.0.0.1:4011, nginx in front
npm test                     # node --test: domain rules, exchange adapters, CSV parser (no DB needed)
```

## Desk workflow
Masters → Issues: add an issue by hand or **Import issues CSV** (a template download is next to the
button). Masters → Margins: set one client, or **Import margins CSV** — RMS has no available-margin
read API yet, so this snapshot is the gate on every bid. Dashboard watches the live book; Bid book
filters it and offers **Modify** / **Cancel** per bid (modify reuses the place-bid form and re-validates
server-side). Exchange files: preview, then download the NSE or BSE file and upload it on e-OFS / iBBS.

## API
| Method | Path | Page gate |
|---|---|---|
| GET | `/api/dashboard` | ofs-desk |
| GET/POST/PUT/DELETE | `/api/issues` | ofs-masters (read: +ofs-desk) |
| GET/POST/PUT/DELETE | `/api/bids`, `POST /api/bids/validate` | ofs-desk |
| GET | `/api/clients`, `/api/clients/:ucc` | ofs-desk (PII masked) |
| GET/PUT/POST | `/api/margin`, `/api/margin/bulk` | ofs-masters |
| GET | `/api/export/:exchange/preview`, `/download`, `/api/export/log` | ofs-desk |
| GET/POST | `/api/allotment`, `/import`, `/mail`, `/mail/reset` | ofs-desk |
| GET | `/api/allotment/mail/status` | ofs-desk |
| GET | `/auth/sso?t=` · POST `/auth/sso/exchange` · POST `/auth/logout` | none — these establish the session |

## Repository

`git@github.com:sachienbansode/ashika-ofs.git` (private) — branch `main`.

## Deploy

**Azure VM (Ubuntu) — full runbook: [`docs/DEPLOY_AZURE.md`](docs/DEPLOY_AZURE.md).**
Covers provisioning, the AWS security-group rule the cross-cloud DB hop needs, PM2,
nginx + Let's Encrypt, and a symptom-to-cause table. nginx template:
[`deploy/nginx/ofs.conf`](deploy/nginx/ofs.conf).

## Deploy — two blocks, always

Local (Windows PowerShell):
```powershell
cd "D:\sachin b\projects\OFS"
git add -A
git commit -m "ofs: <change>"
git push origin main
```

First time on EC2 — its own path, own PM2 process (do NOT co-host under `staging-api-app`):
```bash
sudo mkdir -p /var/apps/ashika-ofs-app && sudo chown $USER /var/apps/ashika-ofs-app
git clone git@github.com:sachienbansode/ashika-ofs.git /var/apps/ashika-ofs-app
cd /var/apps/ashika-ofs-app
cp .env.example .env && $EDITOR .env      # both DB connections, JWT_SECRET, CORS_ORIGINS
npm ci --omit=dev
npm run smoke                             # both databases must pass BEFORE migrating
npm run migrate
pm2 start ecosystem.config.js && pm2 save
```

Server — one command, and never `git pull` (a merge can be blocked by an untracked
file, leaving the box on old code while the deploy looks fine):
```bash
cd /var/apps/ashika-ofs-app && ./scripts/deploy.sh
```
OFS migrations run against **`ofs_bids`** on `13.233.106.37` — never against `uat_ananta_staging`,
which is production. Password via `PGPASSWORD` only.

## nginx (own server block — do not co-host under staging-api-app)
```nginx
server {
  listen 443 ssl http2;
  server_name ofs.example.com;
  location / {
    proxy_pass http://127.0.0.1:4011;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Two front ends

| URL | Who | How they get in |
|---|---|---|
| `/` | Clients | Mobile + registered email, then a one-time code emailed to the address **on file** |
| `/desk` | OFS team | Portal SSO handoff (`docs/platform-patch/`), plus the `ofs-desk` grant |

Separate directories under `public/`, separate cookies, separate tables. A client is
not a platform user, holds no page grants, and can never satisfy `requirePage`; the
desk's staff token can never satisfy `requireClient`. Both share `/shared/theme.css`
so they look like one product.

## Sign-in

There is **no login form**. Staff authenticate at the existing portal (password,
plus OTP where the account requires it); the portal mints a 60-second single-use
ticket and redirects to `/auth/sso?t=…`, which redeems it and sets this app's own
`ofs_session` cookie. The portal's cookie is scoped to its own origin and cannot
reach this app, which is why OFS issues its own.

The ticket asserts identity only — roles and permissions are re-read from
`"admin-staging-api"` on every redemption **and** on every subsequent request, so a
revoked grant or a disabled account takes effect immediately. It carries the portal's
`sid`, checked against `users.active_sid`, so signing in elsewhere ends the OFS
session too.

**The platform needs a small addition for this** — a drop-in route and instructions
are in [`docs/platform-patch/`](docs/platform-patch/). Until that is deployed and
`OFS_SSO_SECRET` is set in both apps, the desk shows a sign-in prompt and nothing else.

## Masters are fetched, not typed

Both masters come from upstream:

- **Clients** — read live from LD on every request (`db/ldAdapter.js`). Never copied
  into this database; only the UCC is stored as a reference.
- **Issues** — pulled from the exchange (`lib/issueSource/`). Masters → *Fetch from
  exchange* previews what would land, then writes it. Manual entry and CSV import
  remain as a fallback for when a source is unreachable.

The exchange owns the facts — floor price, windows, quantities — and the desk owns
its own decisions, so a refresh updates exchange fields but never touches `status`:
an issue the desk suspended stays suspended. A row missing a symbol, floor price,
ISIN or a usable date is rejected with a reason rather than written half-formed.

Both exchanges refuse plain programmatic requests — BSE answers 403 without
browser-like headers, NSE needs cookies from a prior page view — so `lib/issueSource/http.js`
sends a real User-Agent, a matching Referer and a cookie jar. The data is public;
this is not a paywall, and request volume is kept low.

**The endpoint paths are not documented and do move.** Each source therefore tries
several candidates and reports what every one answered:

```bash
npm run fetch-issues                  # both exchanges, report only, writes nothing
npm run fetch-issues -- --source BSE --raw
npm run fetch-issues -- --apply       # write what was found
```

Run it on the server, where the exchange sites are reachable. If nothing parses,
`--raw` prints what actually came back — that is what the parser gets matched to.

## Client sign-in

The Ashika website links straight to `/` — there is no SSO token to trust, so the app
establishes identity itself. One field takes **either** a registered mobile or a
registered email; a 6-digit code then goes to **both** contacts on file.

Deliberate behaviours, because this endpoint faces the public internet:

- `/client/auth/start` answers **identically** whether or not the pair matched, so it
  cannot be used to discover which mobile/email combinations are clients.
- The code is sent to the contacts **on file**, never to whatever was typed — so
  supplying one identifier cannot redirect the code elsewhere.
- Matching on a single identifier is a weaker claim than requiring both, so
  everything after it carries the weight: on-file delivery only, rate limits per
  identifier and per IP, capped attempts. An identifier alone authenticates nobody.
- Codes are stored as a sha256 hash only, compared in constant time, capped at 5
  attempts, and the attempt is counted *before* comparison so a dropped connection
  cannot buy a free guess.
- Throttled per mobile and per IP, with a resend cooldown.
- A client with several UCCs (families share an email) picks one **after** the code is
  verified — the account list is never shown to an unverified visitor.
- Only `Active` clients can sign in, using the same eligibility rule as the desk.
- `OFS_OTP_TEST_MODE=true` uses a fixed code for testing and is **ignored whenever
  `NODE_ENV=production`**, whatever the flag says.

## Allotment emails

`POST /api/allotment/mail {issue_id}` returns the queue and sends **nothing**. Repeat with
`{issue_id, confirm:true}` to actually send — these go to real clients about real money, so
the send is a deliberate second action. SMTP config is the platform's own
(`"admin-staging-api".smtp_settings`, password AES-GCM sealed with `API_KEY_SECRET`), so
`API_KEY_SECRET` must match the platform byte for byte. Every send is written to the shared
`email_logs` table and shows up in Admin → Email & OTP Logs. Clients with no email on file are
marked `skipped`, not `failed`; `POST /api/allotment/mail/reset` requeues the failures.

## Not done yet (Phase 1 tail)
- Exchange file columns are the representative set — pin them byte-for-byte before go-live.
- `ofs_issue.bse_scrip_code` needs the BSE scrip-code master.
