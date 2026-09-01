# Open decisions — confirm with Ashika before these paths are wired

| # | Decision | Status | Blocks |
|---|---|---|---|
| 1 | Exchanges for Phase 1 | **Both NSE + BSE** (confirmed 01-Sep-2026, internal) | — |
| 2 | Mode A (file) vs early STP | Mode A assumed | Phase 3 |
| 3 | Exact NSE bulk-upload columns | **Open** — pull from NSE member portal | `lib/exchange/nse.js` go-live |
| 4 | Exact BSE iBBS layout (Notice 20120727-26, 3.3.4) + member/trading code | **Open** | `lib/exchange/bse.js` go-live |
| 5 | RMS available-margin read API + earmark | **Open** — none exists today; using `ofs.ofs_margin` snapshot | live margin |
| 6 | AP → client mapping source; APs bid or view only | **Open** | Phase 2 |
| 7 | Website → module SSO + client OTP policy | **Open** | Phase 2 |
| 8 | Issue-master ingestion (manual/CSV vs circular feed) | Manual + CSV for now | automation |
| 9 | Exchange allotment/obligation file layout | **Open** | `routes/allotment.js` parser |
| 10 | Source IP whitelisting / trading-network zone | **Open** | any exchange connectivity |
| 11 | Client authorisation model (consent/POA, mandatory OTP, audit) | **Open** | desk bidding on behalf |

## Schema notes

**`ofs_issue.issue_date`** — the T-day (Non-Retail day) as a plain `date`, filled by the
`ofs_issue_fill_date` trigger from `hni_open` in `Asia/Kolkata` when the caller omits it.
It exists because `hni_open::date` is STABLE, not IMMUTABLE — casting a `timestamptz` to
`date` depends on the session TimeZone, so Postgres refuses it in an index expression
(`ERROR: functions in index expression must be marked IMMUTABLE`, SQLSTATE 42P17).
Deriving it in IST also fixes a real bug: an issue opening 20:00 UTC belongs to the *next*
IST trading day, so a naive UTC cast would file it under the wrong day.

Verified on a scratch PostgreSQL 16 instance (prod runs 18): the migration applies clean and
is re-runnable; the unique index rejects the same scrip on the same trading day regardless of
case or padding and allows it on the next day; `ofs_bid_one_live_uq` rejects a second live bid
and permits a fresh one after a cancel; `ofs_bid_price_ck` rejects a non-cut-off bid with no price.
