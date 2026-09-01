# Ashika OFS — Platform Reuse & Integration Contract

**Purpose.** This file is the knowledge pack for the **new, separate OFS application**. The OFS app is its own repo/deployment but must **reuse** the existing `omnenest-uploader-api` platform (LD data, database, auth, email, PII) instead of re-inventing it. This document is the contract for *what* to consume and *how*, plus the boundary rules.

> Companion: see `CLAUDE.md` in the OFS repo for the short operating guide. See the full spec `Ashika_OFS_Module_Specification.docx` for scope, journeys, data model and NSE/BSE file formats.

---

## 0. Boundary rules (read first)

1. **The OFS app READS LD/DWH data and CALLS shared services (auth/email/RMS).** It does **not** copy client master, margin, or notification logic.
2. **Separate deployment.** OFS is client/AP-facing and time-critical during the bidding window — keep it isolated from the internal ETL/admin console for availability, security and audit. Do not bolt it in as a tab.
3. **Own database `ofs_bids`** on the prod Postgres box (13.233.106.37), with OFS tables under an `ofs` schema inside it. **Superseded the original plan** of an `ofs` schema inside the Ananta database (decided 2026-09-01, when the prod DB was created).
   > **Consequence — read this before writing SQL.** Postgres cannot join across databases. OFS state and LD/DWH now live in *different databases on the same server*, so `ofs.ofs_client` could not remain a view. Client identity is read at request time through `db/ldAdapter.js` and merged in the application. Two pools, two adapters, no cross-database SQL — and still no copy of the client master.
4. **Never duplicate PII handling.** Any client-data view/export must mask via the shared PII rules unless the viewer is explicitly allowed to unmask.
5. **Confirm the open items with Ashika** (see spec §3) before building exchange/margin integrations.

---

## 1. Databases

### 1.1 Two databases, one server (`13.233.106.37` / `ip-172-31-24-77`)

| Database | Holds | Adapter | Env prefix | Access |
|---|---|---|---|---|
| `ofs_bids` | OFS state, under schema `ofs` | `db/ofsAdapter.js` | `OFS_` | read/write (owned) |
| `uat_ananta_staging` | `dwh`, `stg`, `"admin-staging-api"`, `"codifi-uploaderdb"` | `db/anantaAdapter.js` | `ANANTA_` | LD read-only; page_registry write |

- **`uat_ananta_staging` is PRODUCTION** despite the name. Treat every write to it as a prod write.
- **Env:** each connection takes `<PREFIX>_DATABASE_URL` *or* discrete `<PREFIX>_PG_*` vars. `<PREFIX>_PG_PASSWORD` is applied after the URL is parsed and overrides anything embedded in it — keep the password out of the URL.
- **Pool factory:** `db/pool.js`. Both adapters are thin wrappers over it, so a third connection is three lines.
- Data dir on the box: `/var/lib/postgresql/18/main`.
- Run `npm run smoke` after any env change: it proves both connections, checks `CREATE` privilege on `ofs_bids`, and verifies the LD tables carry the columns listed below.

### 1.2 Schemas the OFS app READS (all in `uat_ananta_staging`, via `anantaAdapter` / `ldAdapter`)
| Schema | Use |
|---|---|
| `dwh.tbl_user_info` | Client master / KYC identity, keyed by **UCC** (upper/trim). Verified columns (2026-09-01): **ucc, pan, mobile, email, first_name, middle_name, last_name, client_name, name_asper_pan, ucc_client_category, depository, dp_name, dp_account_no, dpid, status, poa, dob, gender, occupation, address, city, state, country, pincode, is_new_user, mtf_status, etl_loaded_at**. ⚠️ There is **no `name`, `branch` or `category`** column - earlier drafts of this file said otherwise. Display name = `name_asper_pan` → `client_name` → `first/middle/last`; client type = `ucc_client_category`; branch comes from `stg.ask_clientmast.branch_id`. |
| `stg.ask_clientmast` | The richer client record — keyed by `ctermcode` (UCC). Verified columns (2026-09-01): **user_id, cclientname, ctermcode, cstatus, branch_id, first/middle/last_name, name_asper_pan, gender, salutation, marital_status, date_of_birth, occupation, mobile, email_id, email_cc, pan, aadhar, activation_status, client_category, annual_income, authorize_type, npoliticalexposed, income, networth, gst_no, refer_by, unique_id, account_opened, last_traded_date, address1-3, city, state, country, pin_code, residential_status, corr_address1-3, cmtfflag, modified_date, modified_status, etl_loaded_at, etl_load_type**. `last_traded_date` is authoritative — never derive traded-date elsewhere. **OFS deliberately does not select `aadhar`, `annual_income`, `income`, `networth` or `gst_no`** — a bidding desk has no need for them, and not fetching them keeps them out of every OFS view and export. |
| `dwh.mis_branch_dim` | Branch names/regions if OFS needs branch labels. |

**Client eligibility.** `ldAdapter` derives `is_active` from `ask_clientmast.cstatus`,
`ask_clientmast.activation_status` and `tbl_user_info.status` — all must agree, and a client
that cannot be positively confirmed active is treated as inactive. `validateBid` refuses a bid
for such a client, so an ineligible UCC is caught at bid time instead of coming back as an
exchange rejection after the desk has uploaded the file.

> Identity join convention used across the app: normalise UCC as `upper(btrim(ucc))`; normalise phone to last-10-digits `right(regexp_replace(col,'[^0-9]','','g'),10)`. `db/ldAdapter.js` is the single place this SQL lives — `findByUcc`, `findMany`, `search`, `exists`, `enrich(rows)`. Never write a query that names `dwh.` or `stg.` from the OFS pool; it will not resolve.

### 1.3 MySQL destinations (only if a downstream sync is ever needed — NOT for Phase 1)
- `db/connectors/factory.js` → `getPool('OMNENEST', ...)` / `getPool('CODIFI', ...)`; shim `db/mysqlAdapter.js` (`getOmnePool`, `getCodifiPool`, `mysqlQuery`). Remote MySQL, client access only — **no OS/df/superuser**. Env: `OMNENEST_DB_TYPE`, `CODIFI_DB_TYPE` (default `mysql`).

---

## 2. Authentication & authorization

- **Identity:** JWT proves identity only. `middleware/auth.js` (`authMiddleware`, `invalidatePerms`) loads live role/permissions each request from `"admin-staging-api".users JOIN roles`. After it runs:
  ```js
  req.user = { sub, id, email, roleId, role, permissions: { pages: [...] } }
  ```
- **Page gating:** `middleware/pageAccess.js` exports `requirePage(...keys)`, `requireEdit`, `isFullAccess`, `levelFor`, `canViewPII`, `requirePII`. Full access is `'*'`-only. **Every route mount is gated with `requirePage`.**
- **Page registry (auto-register):** `lib/pageRegistry.js` — add page keys to the `PAGES` array and they self-register on startup (no per-page SQL). Use `grantToAdmin: true` for first-run default grant.
  - **OFS additions:** register an **`ofs-desk`** page (Phase 1 OFS-team role) and later `ofs-client` / `ofs-ap`. Give each `nav_ids` + `sort_order`.
- **Meta DB adapter:** `db/adminAdapter.js` → `adminQuery`, `SCHEMA = "admin-staging-api"` (users, roles, page_registry, app_settings live here).

**OFS auth model:**
- **OFS-team (Phase 1):** existing staff JWT + new `ofs-desk` page grant. Reuse as-is.
- **Client (Phase 2):** website redirect → SSO token → verify against `dwh.tbl_user_info` by UCC/PAN → OTP. This is a **new identity path** (not staff users); design a separate client-session table in `ofs`, don't overload staff `users`.
- **AP (Phase 2):** same as client + an AP→client mapping (source to confirm with Ashika).

---

## 3. Email & OTP

- **Shared logger:** `lib/emailLog.js` → `logEmail(d)`, `logFromInfo(base, info)`, `ensureEmailLogs()`. **Every send in the platform is captured** in the email-logs table; OFS bid-OTP and allotment emails must go through this so they appear in Admin → Email & OTP Logs.
- **Branding:** `lib/emailBranding.js` for the house email template.
- **Transport:** reuse the existing mailer wiring (see `workers/etlMailer.js` for how ETL sends + logs). Call `logFromInfo` after each send.
- **OTP:** the platform already does OTP (login/reset). OFS bid-OTP should reuse the same generation + email path; **store OTP as hash only, never viewable** (existing invariant).

---

## 4. PII

- `lib/pii.js`: `maskMobile`, `maskEmail`, `maskPan` (last 5), `maskAadhaar` (last 4), `maskByColumn`, `isPiiColumn`.
- `middleware/pageAccess.js`: `canViewPII`, `requirePII`.
- **Invariant:** masking is applied **unconditionally** in views/exports; unmasking is an explicit, gated admin toggle (fail-closed → masked). OFS client tables and any CSV export must follow this.

---

## 5. RMS / margin  ⚠️ gap to close

- **What exists:** `routes/rms.js` only **writes** RMS config to OMNENEST — `rms-category-assign`, `rms-limits`, `rms-limits-multiplier`, `rms-block-unblock` (via `db.bulkInsert`). Valid segments `FO/COM/CASH/MF/CUR/SLBM`, products `NRML/CNC/ML/MIS/ARB/PMS`, exchanges incl. `NSE/BSE/NSEFO/BFO/...`.
- **What OFS needs (new):** a **read** of a client's **available margin**, and a **block/earmark** against an OFS bid. This does **not** exist yet as a read API.
- **Action:** confirm with Ashika whether their RMS exposes a callable available-margin endpoint. Until then, OFS margin is a manual/snapshot table (`ofs.ofs_margin`) as in the prototype. Do **not** assume `routes/rms.js` gives available margin.

---

## 6. Deploy conventions (MUST match)

Two blocks, always — Local Windows PowerShell + AWS EC2 — and on EC2 **`git fetch origin` BEFORE `git reset --hard`** (stale cached-ref bug has bitten repeatedly).

**App server:** EC2 `ip-172-31-16-17`, code at `/var/apps/staging-api-app`, PM2 process `staging-api-app`, config `ecosystem.config.js`. Node bound to localhost (nginx in front). The **new OFS app gets its own PM2 process, own path, own nginx server block** — do not co-host under `staging-api-app`.

```bash
# EC2 (per app)
cd /var/apps/<ofs-app>
git fetch origin
git reset --hard origin/main
pm2 restart <ofs-app>
pm2 logs <ofs-app> --lines 20
```

DB changes run via `psql` on the DB box (`13.233.106.37`, db `uat_ananta_staging`).

---

## 7. Security invariants (carry over — July 2026 review)

- Full access is `'*'` **only**; every route mount has `requirePage`.
- PII masking is unconditional; unmask is an explicit gated toggle (fail-closed).
- Brute-force / rate limits on auth + OTP endpoints.
- CORS: no arbitrary-origin reflection; explicit allow-list.
- CSP present; `X-Powered-By` hidden; Node bound to localhost behind nginx.
- OTP codes stored as **hash only**, never viewable.
- UI advisory/help text says **"Admin"**, not "Ashika" (branding excepted).

---

## 8. Frontend conventions (if reusing the single-page pattern)

- Existing UI is one `public/index.html`; per-user state via `window.MY_UID` + `localStorage`; **pure-CSS charts (no external chart lib)** to stay CSP-safe.
- The OFS app may instead be a fresh SPA, but keep the CSP-safe, no-inline-external-script discipline.
- The uploaded **`ashika-ofs-bidding.html` prototype is the UX/spec reference** for the OFS desk (masters, bid book, exchange-file export, allotment + email).

---

## 9. What to build fresh in the OFS repo (not reuse)

- `ofs_bids` database + `ofs` schema + `ofsAdapter.js`.
- OFS domain tables (see spec §6): `ofs_issue`, `ofs_bid`, `ofs_margin` (+ `ofs_margin_log`), `ofs_allotment`, `ofs_export_log`, `ofs_audit`, `ofs_setting`. **No `ofs_client`** — the spec's read-through view is now `db/ldAdapter.js`, because the two databases cannot be joined.
- **Per-exchange file adapters** (one NSE, one BSE) — map `ofs_bid` → each exchange's bulk-bid format; pin exact columns from the member circulars.
- Real-time OFS dashboard (issues, live bid book, category split, subscription, countdown).
- Client/AP identity path (Phase 2) — separate from staff `users`.
```
