# `ofs_2026.csv` — the 2026 OFS calendar

27 Offers for Sale that ran on NSE and/or BSE between 1 January and 1 September 2026,
compiled from public reporting (Zerodha's monthly OFS bulletins, Chittorgarh's
per-issue pages, IPOWatch) and corroborated against news coverage and, where the
filing was reachable, the exchange's own OFS notice PDF. Every row is confirmed by at
least two independent sources on company, floor price and both dates.

Load it with `npm run seed-issues` (or Masters → Import issues CSV).

## What is NOT confirmed, and is therefore marked

**`ISIN-UNKNOWN`** — the ISIN could be confirmed from a primary filing for only four
issuers (ACL, IRFC, SWANDEF, EASTSILK). The rest carry the literal string
`ISIN-UNKNOWN` rather than a plausible-looking ISIN, because a wrong ISIN in an
exchange bid file is worse than an obviously absent one. `lib/exchange/` refuses to
write a bid file for an issue whose ISIN is not a valid ISIN, so these rows are
readable history that cannot silently reach an exchange. Fill the real ISIN in
Masters → Issues before bidding on any of them.

**BSE scrip codes** are set for four issues only (532141, 543257, 540565, 590022).

**`BOSCH-HCIL`** is how the source rendered Bosch Home Comfort India's ticker; the
NSE symbol was not confirmable.

**`CLCIND`** is listed as BSE-only by one source and BSE+NSE by another. Recorded as
BSE.

**`KRT`** (Knowledge Realty Trust) is the one issue in this file whose retail window
is *not* in the past as of 1 September 2026 — so the archive sweep leaves it alone.

Windows are set to the standard session, 09:15–15:30 IST, on the T and T+1 dates.
The exchanges' actual OFS windows for a given issue can differ; correct any issue you
intend to bid on against its own notice.
