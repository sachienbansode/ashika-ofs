# Getting OFS data without typing it — what to ask NSE and BSE for

Researched 2 September 2026. Ashika is a trading member on both exchanges, so the
question is not "is there an API" but "which of the member entitlements you already
qualify for carry OFS data, and how do you switch them on".

**The short answer: there is exactly one.** The NSE e-OFS Web API covers NSE end to
end — issue master *and* order entry. BSE has no OFS API at all. Everything else is
either out of scope or announcement-detection only.

---

## 1. NSE e-OFS Web API — the one that solves this ★

| | |
|---|---|
| Document | *NSEIL — Offer for Sale System WEB API Protocol*, **v1.3.0, Feb 2024** |
| Spec | https://nsearchives.nseindia.com/web/sites/default/files/inline-files/OFS-WEB%20API_Ver1.3.pdf |
| Production | `https://eofs.nseindia.com/api/` · UI `https://eofs.nseindia.com/ui/` |
| UAT | `https://www.eofsuat.com/api/` |
| Auth | `POST /auth/token` → Bearer; `POST /auth/refreshToken`. HTTPS + JSON. |
| Cost | **No separate licence or published fee.** Open to any trading member. |

**`GET /query/activeSecurities` is the issue master we are missing.** It returns
`symbol, securityName, isinCode, faceValue, tickSize, regularLotSize` plus, per
series: `issueSize, basePrice, openOnDate, mktOpenTime, mktCloseTime,
mktModCxlOpenTime, mktModCxlCloseTime, isNewOrderAllowed, isModificationAllowed,
isCancellationAllowed, orderValueUpperLimit`.

That is the ISIN, tick, lot, floor price, offer size and both windows — everything
the desk retypes today, plus the exchange's own modify/cancel window, which is
better than our `daily_cutoff` guess.

It also replaces file upload entirely when we want it to: `POST /order`,
`PUT /order`, `DELETE /order`, `POST /order/batch`, and a **server-push stream**
(`GET /messaging/message-stream`) carrying broadcasts and market-by-price.

**Two gaps to plan around.** `basePrice` is almost certainly the floor price but the
semantics need confirming against the data dictionary before we map it. And there is
**no indicative-price field anywhere in the API** — that number appears only on NSE's
public cumulative-demand page, so the desk keeps entering it by hand for now.

**How to switch it on:** raise an **ENIT** request for e-OFS Admin creation → NSE
emails admin credentials → OTP → admin creates users → enable API users at
**ENIT → Membership → Enablement → eOFS**. Contact **msm@nse.co.in**,
**1800 266 0050 (option 1)**.

---

## 2. BSE iBBS — no API, and that is the answer

iBBS gives web bid entry, **bulk upload of up to 100 records per CSV/TXT**, bid-book
download, and the allocation file under **OFS → Downloads → Bid Download**.

No REST or web-service interface for OFS is published anywhere. BSE *does* publish
API specs when they exist — StAR MF Web Services v3.5, the NTA ETI API Manual v1.4.8
— and **neither covers OFS or iBBS**. This is a negative finding, so get it in
writing rather than assuming.

Practical shape: **automate NSE fully; for BSE keep generating the 100-record CSV**
(which this app already does, with part-splitting) and upload it. That is not a
workaround — it is the sanctioned member interface.

Contact **bsehelp@bseindia.com** with the Member ID. Mock and Live credentials are
separate.

---

## 3. Market-data licensing — neither exchange carries OFS

**NSE Data & Analytics** (marketdata@nse.co.in) and **BSE market data**
(datafeed@bseindia.com) both sell real-time, EOD, historical and corporate data.
Nothing in either catalogue mentions OFS, offer for sale or book building. These are
secondary-market feeds. Worth one email each to close the option formally, but do not
expect a product.

---

## 4. Free win available today: the NSE circulars RSS

`https://nsearchives.nseindia.com/content/RSS/Circulars.xml` — verified live, current
to 1 Sep 2026. NSE publishes a per-issue circular titled **"Proposed Offer for Sale by
&lt;Company&gt;"** under the **CMTR** department.

A poller filtering `CMTR` + `Offer for Sale` gives us OFS announcements the moment
they publish: free, licensed, no scraping, no terms problem. It is *detection*, not
structured data — the PDF still needs reading — but paired with `activeSecurities`
for the numbers it removes the "did we miss an OFS?" risk entirely.

NSE also offers **email subscription to circulars by category** on the exchange
communication circulars page. The curated OFS-circulars page is stale (newest entry
2016) — do not build against it.

BSE's notices RSS (`https://www.bseindia.com/data/xml/notices.xml`) is cited by third
parties but BSE blocked verification; test it from the office network.

---

## 4b. BSE announcements — the harder half, and how to close it

BSE has no OFS API and, unlike NSE, **no usable public feed**: `notices.xml` and the
RSS index both return **403 to any non-browser client** (verified 2 Sep 2026). A
poller running on the Azure VM would get the same 403, so building against it would
be building against something that does not answer. Do not.

Three routes, best first.

**1. NSE already covers most of it — measure the gap before spending on it.**
An OFS on both exchanges gets an NSE circular, so the NSE feed catches it. In our own
2026 calendar that is **21 of 27 issues (78%)**. The six it misses are BSE-exclusive
micro-caps — Aanchal Ispat, CLC Industries, HMA Agro, String Metaverse, Riddhi Siddhi
and East India Drums. If Ashika does not participate in that tier, BSE detection may
not be worth building at all. **Ask the desk before assuming it is.**

**2. BSE email notices → a watched mailbox (recommended).**
BSE already emails notices to members. That is BSE *sending* Ashika the data, which
sidesteps both the 403 and the terms question entirely. Create a dedicated mailbox
(e.g. `ofs-notices@ashikagroup.com`), subscribe it to BSE member notices, and have
this app read it over IMAP with the same title matching the NSE watcher uses.

We can build that in a day once the mailbox exists — the matching, storage, dedupe,
queue and alerting are already written and source-agnostic (`ofs_circular.source`).
What we need from Ashika: the mailbox, IMAP host and credentials, and confirmation
that BSE notice emails will be delivered to it.

**3. Ask BSE to whitelist the server, in the same letter as everything else.**
Add one line: *"Please advise the correct machine-readable source for BSE notices, or
whitelist our server IP for `bseindia.com/data/xml/notices.xml`."* Costs nothing to
ask, and their answer decides whether route 2 is permanent or a stopgap.

Until one of these lands, BSE-only issues are entered by hand — which is what happens
today, so nothing regresses.

## 5. NSE Extranet API — for the allotment files, not announcements

`https://www.connect2nse.com/extranet-api/`. Register on the Member Portal
(`https://ims.connect2nsccl.com/MemberPortal/`); auth is AES-256-ECB of the password
with an issued secret key, token valid one hour, one concurrent login per API user.
Delivers segment files as `.gz`. **Internet FTP is discontinued** — if anything still
collects NSE files by FTP, it is on borrowed time. Useful for automating OFS
post-trade file pickup.

---

## Two dead ends, so nobody wastes a month on them

**NOW / NEAT-on-Web.** e-OFS replaced the NEAT-based OFS system on 20 Feb 2020, and
NSE's own FAQ says *"Existing APIs for NNF shall be discontinued and only Web API
shall be available."* Any vendor pitching NOW-based OFS connectivity is selling
something withdrawn.

**Scraped website JSON.** NSE's `/market-data/ofs-information` pages render from
undocumented internal endpoints, and several open-source libraries scrape them. They
are unlicensed, unsupported, contractually unstable, and scraping breaches the
website terms. Not suitable for a SEBI-registered member's production order flow —
which is exactly why `EXCHANGE_WEB_FETCH` is off in this app.

---

## Documents Ashika must obtain (member-only — we cannot)

1. **NSE/CMTR/72975 (24 Feb 2026)** — current revised OFS operating guidelines.
   Highest priority; may supersede parts of the v1.3.0 spec, and it is what pins our
   NSE bid-file column layout.
2. **Confirmation of the current OFS Web API version** — v1.3.0 is the newest
   publicly indexed; a later one may sit behind ENIT.
3. **BSE Notice 20240701-19 (1 Jul 2024)** — revised BSE OFS operational guidelines.
4. **BSE Notice 20130129-23** — the allotment/allocation file layout.
5. **Any IP-whitelisting or certificate annexure for e-OFS** — absent from the public
   spec, but NSE normally requires it.

## What to ask for, in order

1. **NSE MSD** (msm@nse.co.in) — ENIT request for **e-OFS Admin creation**, then API
   user enablement. In the same mail ask for: the current protocol version, **UAT
   access to eofsuat.com**, the mock-session calendar, and whether IP whitelisting or
   certificates are required.
2. **NSE MSD** — request **NSE/CMTR/72975**.
3. **Build the circulars RSS poller now** — zero cost, zero dependency, works today.
4. **BSE** (bsehelp@bseindia.com) — iBBS Mock and Live credentials, the current
   bulk-upload spec, Notice 20240701-19 and 20130129-23, and put in writing: *"Is any
   API or web-service interface available for OFS bidding on iBBS, or is web UI plus
   CSV upload the only option?"*
5. **Both market-data desks** — one line each asking whether any licensed product
   carries OFS announcements. Expect no; get it on record.
6. **NSE Member Portal** — Extranet API credentials for post-trade file collection.
   Independent of 1–2, can run in parallel.

Once 1 and 2 land, the NSE half of this module stops being file-and-upload and
becomes straight-through — which is Phase 3 in the specification, reachable earlier
than the spec assumed.
