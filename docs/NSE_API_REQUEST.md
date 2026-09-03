# What to ask NSE for — automated OFS fetch and straight-through bidding

For Ashika to send to **NSE Member Service Department** (`msm@nse.co.in`, 1800 266 0050
option 1). Everything below is quoted from NSE's own published protocol, so the desk
is asking for a documented entitlement rather than a favour.

---

## What we are actually asking for, and why

`GET /query/activeSecurities` on NSE e-OFS returns, per open OFS:

> `symbol, securityName, isinCode, faceValue, tickSize, regularLotSize` and, per
> series: `issueSize, basePrice, openOnDate, mktOpenTime, mktCloseTime,
> mktModCxlOpenTime, mktModCxlCloseTime, isNewOrderAllowed, isModificationAllowed,
> isCancellationAllowed, orderValueUpperLimit`

That is the entire issue master the desk retypes today — ISIN, tick, lot, floor
price, offer size, and both windows plus the exchange's own modify/cancel window.
**This one endpoint is the automated OFS fetch.** Everything else below is what is
needed to reach it.

The same credentials also open `POST /order`, `PUT /order`, `DELETE /order` and
`POST /order/batch`, which would replace file generation and manual upload on NSE
entirely. Worth asking for in the same request even if bidding stays manual at first.

---

## The one question that changes the architecture

**Ask this first, because the answer decides where the software runs.**

> Does e-OFS Web API access have to originate from the member's trading network
> (leased line / co-location), or is access from the public internet over HTTPS
> acceptable for an API user?

The OFS module runs on a cloud server. If NSE requires the request to come from the
trading network, the module cannot call the API directly and we would need a small
connector inside Ashika's own network to relay it. That is a different piece of work,
and it is far cheaper to know now than after enablement.

Ask in the same breath:

- Which **source IP addresses** must be whitelisted, and what is the process and lead
  time to add or change one?
- Is a **client certificate (mTLS)** required, or is the Bearer token from
  `POST /auth/token` sufficient? *(The public protocol document does not mention
  certificates; absence from a public PDF is not proof of absence in practice.)*

---

## The request

**1. Enablement**

- Create the **e-OFS Admin** for our member code (raised on ENIT).
- Enable **API users** at ENIT → Membership → Enablement → eOFS.
- Confirm whether API access is covered by our existing e-OFS entitlement or needs
  separate approval, and whether any fee applies.
- We would like a **dedicated API user**, separate from any dealer login, so that
  automated access can be revoked without disturbing the desk.
- Note: the protocol states **one concurrent login per API user**. Please confirm,
  and advise how a second environment (UAT alongside production) should be handled.

**2. UAT and mock**

- Credentials for **`https://www.eofsuat.com/api/`**.
- NSE's FAQ (v3.0, Q7) says mock sessions run *"only when a new functionality is
  released"* — so rather than asking for a calendar: **can a test OFS be made
  available on UAT** for us to run end to end, and will we be told when the next mock
  is scheduled?

**3. Documents**

- **Circular NSE/CMTR/72975 (24 Feb 2026)** — the current revised OFS operating
  guidelines.
- Confirmation that **"Offer for Sale System WEB API Protocol v1.3.0 (Feb 2024)"** is
  the current version, or the later one if it is not. *(NSE's FAQ points to
  `www1.nseindia.com/technology/content/trading_protocols.htm` → Protocol documents
  for WEB based interfaces → eOFS as the canonical location — worth checking there
  before asking.)*
- The **bulk-upload CSV specification** for `POST /order/batch`: the exact **column
  order**, and whether a **header row** is expected. *(The protocol gives the field
  set and the allowed values, but not the file's column order. We need this whether
  or not we go straight-through, because it is what the desk uploads today.)*

**4. Two field questions**

- **`series`** — the protocol allows `IS`, `RS`, `ES` but does not define them.
  Please confirm which applies to Non-Retail, to Retail, and whether `ES` is only for
  an employee tranche.
- **`basePrice`** — please confirm this is the **floor price** as announced by the
  seller.

**5. Operational limits**

- Any **rate limit or minimum polling interval** on the query endpoints. We intend to
  poll `activeSecurities` a few times an hour, and would rather match NSE's expected
  cadence than discover it by being throttled.
- Token lifetime and the expected use of `POST /auth/refreshToken`.
- Whether the **`/messaging/message-stream`** push stream is available to API users,
  since it would remove polling altogether.

**6. Support**

- The right contact and escalation path for API and connectivity issues **during a
  bidding window**, which is the only time it matters.

---

## Separately, to BSE (`bsehelp@bseindia.com`, quoting the Member ID)

BSE publishes no OFS API, and we would like that on record rather than assumed:

> Is any API or web-service interface available for OFS bidding on iBBS, or is the
> web interface plus CSV/TXT bulk upload the only option?

Also request:

- **iBBS Mock and Live credentials** (they are issued separately).
- Confirmation that **Notice 20150122-30** is still the current bulk-upload and
  download file specification, or the notice that supersedes it.
- Whether a **machine-readable feed of BSE notices** exists for members, or whether
  our server IP can be whitelisted for `bseindia.com/data/xml/notices.xml` — it
  currently returns 403 to anything that is not a browser.

---

## What Ashika does not need to ask for

- **NSE and BSE market-data licensing.** Neither catalogue carries OFS announcements;
  both were checked. Asking wastes a procurement cycle.
- **NOW / NEAT-based OFS connectivity.** Withdrawn when e-OFS replaced it in February
  2020. If a vendor proposes it, that is a reason to doubt the vendor.

## What is already working without NSE's involvement

The NSE **circulars RSS feed** is public and licensed, and the module already polls
it — every OFS gets a circular, and a new one now creates a provisional issue with
the circular attached. That covers *knowing an OFS exists*. What it cannot do is give
structured floor prices and windows, which is exactly what `activeSecurities` is for.


---

## Confirmed by NSE's own FAQ (v3.0, March 2026)

Ashika supplied "FAQs on e-OFS" v3.0. It settles several points, and none of them
require asking:

* **The enablement path is exactly as above** — request e-OFS access on ENIT, receive
  Admin credentials by email, verify with an OTP, then the Admin creates branches and
  users. API users are enabled at **Membership → Enablement → eOFS** (Q5, Q9, Q10).
* **NNF APIs are discontinued; only the Web API remains** (Q8). Anything built on the
  old non-NEAT front end is dead.
* **NSE/CMTR/72975 (24 Feb 2026)** is confirmed as the current OFS circular (Q15) —
  it remains the one document we still need.
* **Only trading members reach the OFS module**; investors bid through their member
  (Q3). Our model is correct.
* Contact is **msm@nse.co.in / 1800 266 0050 option 1** (Q16).

### And one thing it changed in the build

**Q12: the floor price is not necessarily published.**

> "Floor price is the minimum price at which seller wants to sell his shares.
> However, this information is not declared to the market & is informed to the
> designated exchange one day prior to the day of OFS after the closure of the
> trading hours."

Our schema had `floor_price NOT NULL CHECK (> 0)`, so an OFS without a published
floor could not be stored at all — the desk would have had to invent a number, and
every price check downstream would then have been enforcing a fiction. Fixed in
migration 014; see the commit for what changed in the bidding rules.

**Still not answered anywhere in the FAQ**, so it stays at the top of the request:
whether API access must originate from the member's trading network, and what
IP whitelisting or certificates are required.
