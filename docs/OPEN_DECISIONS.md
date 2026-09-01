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
