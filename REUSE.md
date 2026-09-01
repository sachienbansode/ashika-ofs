# Ashika OFS — Platform Reuse & Integration Contract

**Purpose.** This file is the knowledge pack for the **new, separate OFS application**. The OFS app is its own repo/deployment but must **reuse** the existing `omnenest-uploader-api` platform (LD data, database, auth, email, PII) instead of re-inventing it. This document is the contract for *what* to consume and *how*, plus the boundary rules.

> Companion: see `CLAUDE.md` in the OFS repo for the short operating guide. See the full spec `Ashika_OFS_Module_Specification.docx` for scope, journeys, data model and NSE/BSE file formats.

---

## 0. Boundary rules (read first)

1. **The OFS app READS LD/DWH data and CALLS shared services (auth/email/RMS).** It does **not** copy client master, margin, or notification logic.
2. **Separate deployment.** OFS is client/AP-facing and time-critical during the bidding window — keep it isolated from the internal ETL/admin console for availability, security and audit. Do not bolt it in as a tab.
3. **New Postgres schema `ofs`** on the **same Ananta instance** as `stg`/`dwh` — so LD/DWH data is reachable by query while OFS state stays isolated.
4. **Never duplicate PII handling.** Any client-data view/export must mask via the shared PII rules unless the viewer is explicitly allowed to unmask.
5. **Confirm the open items with Ashika** (see spec §3) before building exchange/margin integrations.

---

## 1. Databases

### 1.1 Ananta Postgres (primary — LD, DWH, and new OFS schema)
- **Instance:** `uat_ananta_staging` (Staging/UAT). Same instance hosts `stg`, `dwh`, `"codifi-uploaderdb"`, `"admin-staging-api"`.
- **Env:** `PG_HOST`, `PG_PORT` (5432), `PG_DATABASE` (`uat_ananta_staging`), `PG_USER`, `PG_PASSWORD`. Prod via `PROD_ANANTA_DATABASE_URL`.
- **DB box:** separate server `13.233.106.37` / `ip-172-31-24-77`, data dir `/var/lib/postgresql/18/main`.
- **Pattern to copy:** `db/codifiAdapter.js` is a minimal `pg.Pool` + `query(sql, params)` + a fixed `SCHEMA` constant. The OFS app should create its own `ofsAdapter.js` the same way with `SCHEMA = 'ofs'`.

### 1.2 Schemas the OFS app READS
| Schema | Use |
|---|---|
| `dwh.tbl_user_info` | Client master / KYC identity: **ucc, pan, name, middle_name, name_asper_pan, mobile, email, depository, dp_name, branch, category, is_new_user, etl_loaded_at**. Keyed by **UCC** (upper/trim). |
| `stg.ask_clientmast` | `branch_id`, **`last_traded_date`** (authoritative — never derive traded-date elsewhere), `ctermcode`(UCC). |
| `dwh.mis_branch_dim` | Branch names/regions if OFS needs branch labels. |

> Identity join convention used across the app: normalise UCC as `upper(btrim(ucc))`; normalise phone to last-10-digits `right(regexp_replace(col,'[^0-9]','','g'),10)`.

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

- `ofs` schema + `ofsAdapter.js` (mirror `codifiAdapter.js`).
- OFS domain tables (see spec §6): `ofs_issue`, `ofs_bid`, `ofs_margin`, `ofs_allotment`, `ofs_export_log`, `ofs_audit`; `ofs_client` as a **view** over `dwh.tbl_user_info`.
- **Per-exchange file adapters** (one NSE, one BSE) — map `ofs_bid` → each exchange's bulk-bid format; pin exact columns from the member circulars.
- Real-time OFS dashboard (issues, live bid book, category split, subscription, countdown).
- Client/AP identity path (Phase 2) — separate from staff `users`.
```
