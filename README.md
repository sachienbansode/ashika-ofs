# Ashika OFS — Phase 1

Separate OFS application: OFS-desk role, real-time bidding dashboard, and one-click
NSE / BSE bid-file download. Reuses the `omnenest-uploader-api` platform for LD data,
DB, auth/roles, email and PII — see `REUSE.md`. Full spec: `Ashika_OFS_Module_Specification.docx`.

## Layout
```
db/ofsAdapter.js        pg.Pool + query/one/rows/tx, SCHEMA='ofs'   (mirrors codifiAdapter.js)
db/adminAdapter.js      reads "admin-staging-api" (users, roles, page_registry)
db/migrations/001_*.sql ofs schema: issue, bid, margin(+log), allotment, export_log, audit, client VIEW
lib/domain.js           SEBI/exchange bid rules ported from the prototype (server-side truth)
lib/exchange/nse.js     NSE e-OFS bulk-upload mapping      <- pin columns from the member circular
lib/exchange/bse.js     BSE iBBS bulk-bid mapping          <- pin columns from BSE Notice 20120727-26
lib/pii.js              mask mobile/email/PAN/Aadhaar
lib/pageRegistry.js     self-registers pages: ofs-desk, ofs-masters
middleware/auth.js      JWT identity + live role/perm load each request
middleware/pageAccess.js requirePage / requireEdit / canViewPII ('*' = full access only)
routes/                 dashboard, issues, bids, clients, margin, export, allotment
public/                 CSP-safe desk SPA (no inline script, no CDN, no chart lib)
```

## Run
```bash
cp .env.example .env         # fill PG_*, PGPASSWORD, JWT_SECRET, CORS_ORIGINS
npm install
npm run migrate              # applies db/migrations/*.sql, tracked in ofs._migration
npm start                    # binds 127.0.0.1:4011, nginx in front
```

## API
| Method | Path | Page gate |
|---|---|---|
| GET | `/api/dashboard` | ofs-desk |
| GET/POST/PUT/DELETE | `/api/issues` | ofs-masters (read: +ofs-desk) |
| GET/POST/PUT/DELETE | `/api/bids`, `POST /api/bids/validate` | ofs-desk |
| GET | `/api/clients`, `/api/clients/:ucc` | ofs-desk (PII masked) |
| GET/PUT/POST | `/api/margin`, `/api/margin/bulk` | ofs-masters |
| GET | `/api/export/:exchange/preview`, `/download`, `/api/export/log` | ofs-desk |
| GET/POST | `/api/allotment`, `/import`, `/mail` | ofs-desk |

## Deploy — two blocks, always

Local (Windows PowerShell):
```powershell
git add -A
git commit -m "ofs: <change>"
git push origin main
```

EC2 (`git fetch` BEFORE reset — stale cached-ref bug):
```bash
cd /var/apps/ashika-ofs-app
git fetch origin
git reset --hard origin/main
npm ci --omit=dev
pm2 restart ashika-ofs-app
pm2 logs ashika-ofs-app --lines 20
```
DB changes via `psql` on `13.233.106.37`, db `uat_ananta_staging` (password via `PGPASSWORD` only).

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

## Not done yet (Phase 1 tail)
- Allotment emails: vendor the platform mailer + `lib/emailLog.js` so sends land in Admin → Email & OTP Logs (`routes/allotment.js` returns 501 today).
- Exchange file columns are the representative set — pin them byte-for-byte before go-live.
- `ofs_issue.bse_scrip_code` needs the BSE scrip-code master.
