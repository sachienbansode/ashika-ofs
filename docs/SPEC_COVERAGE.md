# Specification coverage — v1.0 (01-Sep-2026) against the build

Checked on 2 September 2026 at commit `2f7df44`, section by section against
*Ashika OFS Module — Product & Technical Specification v1.0*.

**Phase 1 is complete and then some.** Two of its items are done but cannot be
*trusted* until an exchange document is in hand, and three are blocked on answers
Ashika's own checklist (spec §3) asks for. Phases 2 and 3 are, as specified, later.

---

## Phase 1 — OFS desk (the document's build scope)

| § | Requirement | State |
|---|---|---|
| 5.1.1 | OFS-team role, existing auth | **Done.** `OFS-Backoffice` role SQL in `docs/sql/`; `SuperAdmin` (`*`) already reaches it. Two doors: portal SSO (`/auth/sso`) and a direct sign-in at `/backoffice/login.html` |
| 5.1.2 | All open issues: scrip, ISIN, exchange, floor, cut-off, both windows, discount, live status | **Done.** Dashboard cards, status computed per category (Upcoming / Open / Closed) with a live countdown |
| 5.1.3 | Live bid book: bids, qty, value, Retail/HNI split, subscription ×, indicative price, auto-refresh | **Done except the indicative price.** Everything computes; `indicative_ri` / `indicative_ni` are columns the desk types in, because the exchange publishes that figure only on the member terminal (§3) |
| 5.1.4 | Review/manage bids: filter, search, spot rejects, place/modify/cancel on behalf | **Done.** Bid book with filters and search; validation names the reason (below floor, over cap, margin short, wrong tick/lot, duplicate live bid) |
| 5.1.5 | Download NSE and BSE files in native formats, re-export after modification | **Done, one caveat below.** Adapter per exchange, part-splitting, preview before download, every file logged with a sha256 |
| 5.1.6 | Import allotment file, compute allotment, email allotted clients | **Done.** CSV import, per-client allotment, branded mail through the shared logger, send status and resend |
| 6 | `ofs` schema: issue, bid, client, margin, allotment, export_log, audit | **Done, one deviation.** All seven exist. `ofs_client` is **not** a view — see below |
| 4.1 | Reuse map: LD identity, database, auth/roles, email+OTP, PII masking | **Done.** `db/ldAdapter.js`, `lib/pageRegistry.js`, `middleware/pageAccess.js`, shared mailer + email log, `lib/pii.js` with a gated unmask |
| 8 | Mode A (file), human in the loop | **Done.** No direct exchange write exists in the code |

### The one deviation from the data model

Spec §6 specifies `ofs_client` as *"a view over `dwh.tbl_user_info`"*. **That view cannot
exist.** `ofs_bids` and `uat_ananta_staging` are different databases, and PostgreSQL
cannot join across databases — a view in one cannot read a table in the other. Client
data is instead read live through `db/ldAdapter.js` on its own pool and merged in the
app. The boundary rule the spec actually cares about is kept: read-only, never copied,
only the UCC stored as a reference.

### Beyond the spec

Archive (§ not specified) — a closed OFS is archived automatically with its full
history intact; nothing is deleted. Exchange pull with a schedule, progress and a
per-endpoint log. Admin-configurable cut-off, market hours, trading days and holidays.
Client sign-in by client code / mobile / email with OTP. 97 tests.

---

## Cannot be trusted until Ashika supplies a document (spec §3 asks for exactly these)

**NSE bulk-upload column layout.** Written from the best public description, and
flagged as unverified in `lib/exchange/nse.js`. Needs the current spec from the member
portal — circular NSE/CMTR/72975 — because column order must match byte-for-byte.

**BSE allotment file layout.** The import reads a sensible CSV; BSE Notice 20130129-23
defines the real one.

The BSE *bid* file is in better shape: rebuilt from BSE's published OFS guidelines —
ten fields, no header row, action `N`/`M`/`D`, 100 records per file with part-splitting.
Still worth confirming against the current circular before go-live.

---

## Blocked on the §3 checklist

| Item | Why it blocks |
|---|---|
| RMS margin API | `ofs_margin` is fed manually or by CSV. A live read and an earmark need the API §3 asks about |
| Client authorisation model (consent/POA, mandatory OTP, whether the client must see the live indicative price) | Decides how much of the Phase 2 client journey is even permitted |
| AP→client mapping source, and whether APs bid or only view | `stg.branchho` is the likely source; the rule is not settled |
| Exchange web fetching | Off by default: both exchanges' terms prohibit automated collection without written consent. The sanctioned route is the T-2/T-1 member notice via CSV import |

---

## Phase 2 — Client & AP self-service (specified as later)

Sign-in **done** (LD identity + OTP, by client code, mobile or email). Read-only client
views **done** — open issues, my bids, my allotments. **Not built:** client bid
placement with OTP at bid time, and the AP journey in full. Both wait on the
authorisation model and the AP mapping rule above.

## Phase 3 — Straight-through (specified as later)

Not started, as specified. NSE OFS Web API onboarding, live indicative price and RMS
earmarking all depend on §3 answers.

---

## What to ask Ashika for, in order of what it unblocks

1. **NSE OFS bulk-upload spec** (member portal) — until this is pinned, a generated NSE
   file is a best guess.
2. **BSE allotment/obligation file format** (Notice 20130129-23) — needed before the
   first real allotment run.
3. **RMS margin API** — the margin gate is currently manual.
4. **Client authorisation model** and **AP mapping** — these two define Phase 2.
