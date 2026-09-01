# CLAUDE.md — Ashika OFS Application

Operating guide for working in this repo. Read `REUSE.md` (integration contract) and `Ashika_OFS_Module_Specification.docx` (full spec) before building.

## What this project is
A **separate** application that lets Ashika offer **Offer for Sale (OFS)** to clients and Authorised Partners (APs). It is **not** part of `omnenest-uploader-api` (the internal ETL/admin console); it runs on its own deployment but **reuses that platform's data, DB, auth, email and PII services** — see `REUSE.md`.

**Phase 1 scope (build now):** an **OFS-team user role** with a **real-time bidding dashboard** and one-click **download of aggregated bids in NSE and BSE native file formats**, which the desk uploads to NSE e-OFS / BSE iBBS. File-based to the exchange (no straight-through API yet).

**Later phases:** client & AP self-service (website redirect + LD/OTP auth), live RMS margin checks, and NSE OFS Web API straight-through.

## Golden rules
1. **Reuse, don't reinvent.** LD client data, DB, auth/roles, email/OTP, PII masking all come from the existing platform per `REUSE.md`. Read LD/DWH; call shared services.
2. **Isolation.** Own repo, own PM2 process, own nginx block, own `ofs` Postgres schema on the shared Ananta instance.
3. **Client identity ≠ staff users.** Client/AP sessions are a new path (SSO→LD verify→OTP), not the staff `users` table.
4. **PII is masked by default**; unmask is an explicit gated toggle (fail-closed).
5. **RMS available-margin does not exist yet** as a read API — confirm with Ashika before wiring live margin; until then use the `ofs_margin` snapshot table.
6. **Exchange file formats change by circular** — keep NSE and BSE as separate mapping adapters; pin exact columns from the member portals. Log every generated file in `ofs_export_log` with a checksum.

## Deploy (always two blocks; fetch before reset)
Local Windows PowerShell (git add/commit/push) **and** AWS EC2:
```bash
cd /var/apps/<ofs-app>
git fetch origin              # BEFORE reset — stale-ref bug has bitten repeatedly
git reset --hard origin/main
pm2 restart <ofs-app>
pm2 logs <ofs-app> --lines 20
```
DB changes: `psql` on the DB box `13.233.106.37` (db `uat_ananta_staging`). Verify every JS change with `node --check` before deploy.

## Security invariants (non-negotiable)
`'*'`-only full access · `requirePage` on every mount · unconditional PII masking · rate-limits on auth/OTP · no CORS origin reflection · CSP on · OTP stored hash-only · UI help text says "Admin" not "Ashika".

## Reference material
- `REUSE.md` — exact modules/tables/endpoints to consume + boundary rules.
- `Ashika_OFS_Module_Specification.docx` — mechanism, journeys, data model, NSE/BSE formats, phasing, open decisions.
- `ashika-ofs-bidding.html` — the UX/workflow prototype this module is derived from.

## Open decisions to confirm with Ashika (gate the build)
Exchanges for Phase 1 (NSE only vs NSE+BSE) · file vs STP · RMS margin-read availability + OFS margin rules · AP→client mapping source · website→module SSO + client OTP policy · issue-master ingestion (manual/CSV vs exchange feed).
