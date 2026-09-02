# Open decisions

Status as of 2026-09-01. "Settled" means we have an answer and the code reflects it.
"Blocked" means the answer exists outside this project — a member circular, an RMS
capability, or a compliance ruling — and no amount of building resolves it.

## Recently closed

**B — the BSE iBBS bulk-bid layout is now pinned** (2026-09-01), from BSE's own
[Comprehensive Amended Guidelines — OFS Segment](https://www.bseindia.com/downloads1/BSEComprehensiveAmendedGuidelines_OFS_Segment.pdf).
Ten fields, in order, **with no header row**:

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | OFS Symbol | alnum(10) | mandatory |
| 2 | Category | alnum(5) | `MF` · `IC` · `OTHS` · `NII` · `RI` |
| 3 | Client/CP code | alnum(16) | optional, institutional give-ups |
| 4 | UCC | alnum(12) | mandatory |
| 5 | Custodian clearing code | alnum(12) | optional |
| 6 | Qty | num(11) | multiple of market lot |
| 7 | Price | num(6,2) | at or above floor |
| 8 | Margin | num(1) | `1` = 0% · `2` = 100% upfront |
| 9 | Bid Id | num(16) | `0` for a new record |
| 10 | Action Code | alnum(1) | `N` new · `M` modify · **`D` delete** |

Two corrections this forced: cancellation is **D**, not the `C` the prototype used,
and **a file carries at most 100 records**, so a larger book must be split — the desk
now gets numbered parts and is told to upload all of them. Comma or pipe separated
`.csv`/`.txt` are both accepted.

Announcements: BSE issues a **T-2 notice** (company, seller, quantity, bid timing,
allocation method) and a **T-1 floor price and activity schedule notice**, under
Markets → Market Info → Notices/Circulars. Live and forthcoming issues are listed
under Markets → Offer for Sale.

## Settled

| # | Decision | Answer | Where it lives in the code |
|---|---|---|---|
| 1 | Exchanges for Phase 1 | **Both NSE and BSE** from day one | `lib/exchange/nse.js`, `lib/exchange/bse.js` |
| 2 | File upload vs straight-through | **Mode A (file)**; STP is Phase 3 | `routes/export.js` |
| 3 | Website → module SSO | **No SSO.** The website simply links to the OFS app; the client signs in here | `routes/clientAuth.js` |
| 4 | Client sign-in method | **Mobile + registered email, then a one-time code** to the address on file | `lib/clientAuth.js`, `public/client/` |
| 5 | Staff sign-in | **Portal SSO handoff**, single-use ticket, MFA inherited from the portal | `lib/sso.js`, `docs/platform-patch/` |
| 6 | Issue-master ingestion | **CSV from the member notice** (sanctioned). Web fetching is built but off by default — both exchanges prohibit automated collection without written consent, and a dry run showed their public endpoints no longer serve data anyway | Masters → Import issues CSV; `lib/issueSource/` |
| 7 | Margin source | **Snapshot table**, set by the desk or imported by CSV — no RMS read API exists | `ofs.ofs_margin` |
| 8 | Client eligibility | Only clients **Active** in the client master may bid (36,663 of 136,129) | `db/ldAdapter.js`, `lib/domain.js` |
| 9 | Database topology | Own database `ofs_bids`; LD read from `uat_ananta_staging` | `db/pgConfig.js` |
| 10 | Deployment | Azure VM, app only; both databases stay on AWS | `docs/DEPLOY_AZURE.md` |
| 11 | Client sign-in identifier | **Client code (UCC), mobile OR email** — any one, then a code to the contacts on file | `lib/otp.js` `identifierKind` |
| 12 | Closed-issue retention | **Archived, never deleted.** A flag keeps bids, files, allotments and audit attached | migration 005, Masters → Archive |

## Blocked — these need something from outside

| # | Decision | Why it is still open | What it blocks | Who can answer |
|---|---|---|---|---|
| A | **Exact NSE bulk-upload columns** | NSE's layout is not public. The e-OFS FAQ points to the Web API protocol docs and to **circular NSE/CMTR/72975 (24 Feb 2026)**, both member-only. Our NSE adapter currently mirrors BSE's documented layout and emits `C` for a cancellation — BSE documents `D`, so at least one is wrong for NSE. | Go-live on NSE | Ashika's desk, from the NSE member portal, or msm@nse.co.in |
| C | **Allotment file format** | BSE returns an **Allocation File** in iBBS (OFS → Downloads → Bid Download) from 17:30 on T-day, with EOD trade files on the extranet from 18:00. Layouts are in **BSE Notice 20130129-23**, which we do not have. | Automated allotment import | Ashika's desk, from the BSE member portal |
| D | **RMS available-margin API** | `routes/rms.js` on the platform only *writes* RMS config. A read endpoint may not exist at all. | Live margin instead of a snapshot | Ashika IT / RMS vendor |
| E | **AP → client mapping** | User indicated `stg.branchho`; the logic itself is still to be shared. | The whole AP journey | Ashika (logic promised) |
| F | **Client authorisation model** | Consent/POA for bidding on a client's behalf, whether OTP is required per bid as well as at sign-in, and whether the client must see the live indicative price before confirming. | Desk bidding on behalf; per-bid OTP | Ashika compliance |
| G | **BSE scrip code master** | `ofs_issue.bse_scrip_code` has no feed; it is typed in per issue today. | BSE file completeness | Ashika's desk |
| H | **Exchange IP whitelisting** | Only matters when we talk to an exchange directly, i.e. Phase 3. | STP | Ashika IT |

## Why the blocked ones cannot be closed from here

A, B, C and G are **documents held behind member logins** — NSE e-OFS and BSE iBBS
portals. They cannot be inferred, and guessing produces a file the exchange rejects
after the bidding window has closed, which is the worst possible time to discover it.
The adapters are deliberately written as isolated mapping modules with tests, so
pinning them is a small edit rather than a rewrite: change the header array and the
row function in `lib/exchange/nse.js` or `bse.js`, and the tests tell you at once
what else moved.

D is a **capability question**, not a decision: either the RMS exposes a callable
read or it does not. Until someone confirms, a snapshot table is the honest design —
it makes the staleness visible rather than pretending to be live.

E and F are **Ashika's to define**: an AP mapping is a business relationship, and
bidding on a client's behalf is a compliance position, not an engineering choice.

## What is worth chasing first

B and G together unblock BSE, and A unblocks NSE — those three are the only things
between the desk and a real OFS window. F matters before any bid is placed for a
client by the desk rather than by the client themselves.


---

## Multiple accounts on one mobile or email — settled, and worth documenting

Families and HUFs share a mobile and an email across several UCCs, so a single
identifier legitimately matches more than one client. **This is built and working**,
and belongs in the final documentation:

1. The visitor signs in with any one identifier — client code, mobile or email.
2. The one-time code is sent to the contacts **on file**, never to what was typed.
3. **Only after the code is verified** does the app reveal that several accounts
   share those contacts, and list them (UCC, name, branch) for selection.
4. Selecting one establishes a session bound to that single UCC; every bid, margin
   check and allotment from then on is that UCC's alone.
5. To act for another account in the same family, the client signs out and back in,
   and picks the other one. There is no account switcher inside a live session —
   one session, one UCC, so a bid can never be attributed to the wrong client.

The ordering is the security property: an unverified visitor typing a shared mobile
learns nothing about how many accounts use it, or whose. `routes/clientAuth.js`
(`/verify` → `accounts`, then `/select`) and `ofs.ofs_client_otp.uccs`.

**Still open for Phase 2:** whether one family member may place a bid for another's
UCC without signing in as them. That is the client-authorisation question in spec §3
and needs Ashika's answer, not a code change.

## "No client found" at sign-in — a deliberate trade-off

The client sign-in page now says *"No active Ashika account found for that client
code"* instead of advancing to the code step for an identifier that matches nothing.

The cost is that the endpoint confirms whether an identifier belongs to an Ashika
client. It is kept behind the existing throttle (5 attempts per identifier per hour,
20 per IP per hour), which makes bulk enumeration impractical without making a
genuine typo painful.

If compliance would rather give nothing away, `Masters → Settings → Unknown sign-in
identifier` switches it to `generic`, which answers identically either way. **This is
a compliance choice, not a technical one** — record which way Ashika wants it.
