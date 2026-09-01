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

## Staff sign-in — two doors to `/desk`

Both doors lead to the **same** platform accounts in `"admin-staging-api".users` /
`roles`. OFS never stores a staff password and never creates a staff account; it
re-reads role and permissions on every request, so a revoked grant or a disabled
account takes effect within seconds without a restart.

### 1. Direct sign-in — `/desk/login.html`

Email + portal password. If the role (`requires_mfa`) or the account
(`mfa_enabled`) demands it, a 6-digit code follows, emailed to the address on file.
Works today, with no change to the platform.

* An M365 account is refused here — it has no password to check, so it must use the
  portal.
* An account whose role does not include `ofs-desk` (or `*`) is refused at sign-in
  rather than handed a session that can only see an empty page.
* Signing in rotates `users.active_sid`, exactly as the portal does. That is the
  single-session rule working as intended: **signing in here ends an open portal
  session, and a later portal sign-in ends this one.**
* Switch it off with `OFS_STAFF_LOGIN=false` once SSO is deployed.

Sign-in is rate limited to 10 attempts per IP per 15 minutes; a wrong password and
an unknown email give the same message and take the same time.

### 2. Portal SSO — `/auth/sso?t=…` (preferred)

The portal authenticates, mints a 60-second single-use ticket and redirects here;
OFS redeems it and sets its own `ofs_session` cookie. The portal's cookie is scoped
to its own origin and cannot reach this app, which is why OFS issues its own. The
ticket asserts identity only, carries the portal's `sid`, and is refused on replay.
No second password prompt.

**The platform needs a small addition for this** — a drop-in route and instructions
are in [`docs/platform-patch/`](docs/platform-patch/). Until it is deployed and
`OFS_SSO_SECRET` is set in both apps, use door 1.

### Roles

| Role | Reaches the desk | PII unmasked |
|---|---|---|
| `SuperAdmin` (`{"pages":["*"]}`) | yes, nothing to grant | yes |
| `Admin` | yes, `ofs-desk` granted on first app start | no |
| `OFS-Backoffice` | yes | yes (`ofs-desk:pii`) |
| anything else | only if granted `ofs-desk` | only with `:pii` |

Create the role and its first user with
[`docs/sql/ofs_backoffice_role.sql`](docs/sql/ofs_backoffice_role.sql), run in
pgAdmin against the **Ananta** database.

## Archive

A closed OFS is archived, never deleted — this is a regulated bidding record.
Archiving sets a flag, so bids, generated files, allotments and the audit trail stay
attached to the same issue and an archived OFS opens in full years later, with the
same figures it had on the day. `ofs.ofs_issue_summary` is a view, so those figures
are computed from the underlying rows rather than frozen into a snapshot that could
drift.

Masters → Archive lists what is due (default: closed more than `archive_after_days`,
7), archives in one action, and opens any archived issue to show every bid, every
exchange file with its checksum, every allotment and the full audit trail. Restore
puts an issue back on the desk. Archiving an issue whose window is still open is
refused unless forced. Archived issues disappear from the desk dashboard, the issue
master and the client app; PII stays masked in the archive exactly as elsewhere.

## Masters are fetched, not typed

Both masters come from upstream:

- **Clients** — read live from LD on every request (`db/ldAdapter.js`). Never copied
  into this database; only the UCC is stored as a reference.
- **Issues** — pulled from the exchange (`lib/issueSource/`). Masters → **Exchange
  pull** runs it, on demand or on a schedule, and shows every endpoint tried and
  what it answered. Manual entry and CSV import remain as a fallback for when a
  source is unreachable.

The exchange owns the facts — floor price, windows, quantities — and the desk owns
its own decisions, so a refresh updates exchange fields but never touches `status`:
an issue the desk suspended stays suspended. A row missing a symbol, floor price,
ISIN or a usable date is rejected with a reason rather than written half-formed.

Both exchanges refuse plain programmatic requests — BSE answers 403 without
browser-like headers, NSE needs cookies from a prior page view — so `lib/issueSource/http.js`
sends a real User-Agent, a matching Referer and a cookie jar. The data is public;
this is not a paywall, and request volume is kept low.

**⚠ Web fetching is off by default and should stay off.** Both exchanges prohibit it:
NSE's terms bar "systematic or automated data collection activities (including
scraping, data mining, data extraction and data harvesting)" without prior written
permission; BSE's clause 13 bars the same "without our express written consent", and
clause 23 restricts the site to non-commercial use. Ashika is a SEBI-registered
member with an entitlement to the same data through e-OFS, iBBS, the member extranet
and the T-2/T-1 notices — so the sanctioned path is **Masters → Import issues CSV**,
fed from the member notice. `EXCHANGE_WEB_FETCH=true` exists for a permitted
endpoint or once written consent is held.

A dry run on 2026-09-01 also showed it would not work anyway: BSE now serves an
Angular shell whose data loads by internal XHR, and NSE returns 404 for the public
paths. Making it work would mean reverse-engineering their front ends, which is
precisely what the terms prohibit.

### Masters → Exchange pull

A pull walks several endpoints per exchange and can take a minute, so it is a **row
in `ofs.ofs_sync_run`** the desk polls, not a request the browser waits on. The panel
shows a progress bar, a live log of each endpoint and its answer, and a per-exchange
summary card. The outcome is one of four, and the difference matters:

| Outcome | Means |
|---|---|
| `disabled` | `EXCHANGE_WEB_FETCH=false` — nothing was attempted, by design |
| `unreachable` | nothing answered |
| `no_data` | answered, but with nothing that parses as an OFS issue |
| `ok` | issues found and written |

"Could not reach the exchange" used to cover all four, which is why an empty issue
list looked like a network fault when it was a deliberate setting.

**Schedule.** Masters → Exchange pull → *Schedule*: on/off, every 15 minutes to once
a day (hourly is the default), which exchanges, and whether to hold outside market
hours. It is a one-minute timer in the app (`lib/syncScheduler.js`) that asks the
settings table whether a pull is due, so a change takes effect on the next minute —
no restart, and no cron entry on the VM to keep in step with the database. Due-ness
is measured from the last run **in the database**, so a restart neither resets the
clock nor causes a double pull, and a partial unique index means only one pull can
ever be in flight.

A pull still finds nothing while `EXCHANGE_WEB_FETCH=false`. That is the correct
state today — the panel now says so instead of blaming the network.

The discovery tool remains, for a permitted source:

```bash
npm run fetch-issues                  # both exchanges, report only, writes nothing
npm run fetch-issues -- --source BSE --raw
npm run fetch-issues -- --apply       # write what was found
```

Run it on the server, where the exchange sites are reachable. If nothing parses,
`--raw` prints what actually came back — that is what the parser gets matched to.

## Seeding the 2026 calendar

```bash
npm run seed-issues              # 27 OFS from Jan-Aug 2026, then archive the closed ones
npm run seed-issues -- --dry     # parse and report, write nothing
```

`docs/seed/ofs_2026.csv` holds every OFS that ran on NSE/BSE between 1 January and
1 September 2026, compiled from public reporting and corroborated across sources —
see [`docs/seed/README.md`](docs/seed/README.md) for what is and is not confirmed.

**21 of the 27 carry `ISIN-UNKNOWN`.** The ISIN could only be confirmed from a
primary filing for four issuers, and a plausible-looking wrong ISIN in an exchange
bid file is worse than an obviously absent one. `routes/export.js` refuses to build a
file for any issue whose ISIN is not a valid ISIN, so those rows are readable history
that cannot silently reach an exchange; fill the real ISIN under Masters → Issues
before bidding on one.

Re-running is safe: the seed uses the same upsert as an exchange pull, matching on
symbol + ISIN + T-day.

## Archiving expired issues

The scheduler sweeps on the same one-minute tick as the pull, on its own switch
(`archive_auto`, `archive_after_days` — both under Masters → Settings). An issue is
archived once its last window closed more than that many days ago. `archive_after_days = 0`
archives as soon as the window closes.

Archiving is a flag, never a move or a delete: bids, generated files, allotments and
audit rows keep pointing at the same issue, and Masters → Archive opens any of them
in full or restores it.

## When a bid may be placed

Three gates, narrowest wins (`lib/marketHours.js`, `lib/domain.js`):

1. the exchange's own OFS window for that category — T-day Non-Retail, T+1 Retail;
2. the **trading session** — a trading day, not a declared holiday, between
   `market_open` and `market_close`;
3. the **desk cut-off**, which **overrides the session end**.

The override is the point: a desk that stops at 15:15 stops at 15:15 even though the
market runs to 15:30, and a cut-off set *later* than the close is what applies
instead. All four values — open, close, trading days, holidays — are desk-editable
under Masters → Settings, alongside the cut-off.

Everything is compared in `Asia/Kolkata` explicitly. The app server runs UTC, so the
host clock is never consulted for a trading decision; the tests are written as UTC
instants for exactly that reason.

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
