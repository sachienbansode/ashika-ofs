# OFS UAT — branch / AP login and bidding

Grounded in the `ask_clientmast` extract of 2026-09-12: 25,000 clients, **6,714 active**
across **615 branches**; 15,251 Dormant, 2,691 Closed, 344 Suspended.

Everything below is a thing that can actually be wrong. Where a case has a specific UCC
or branch code, it was chosen because that row exercises a rule, not at random.

---

## 0. Before anything else

The branch client list filters on `activation_status = 'Y'`, defaulting to `'Y'` when the
column is null. That column is **not** in the extract, so it is unverified. If a branch
signs in and sees zero clients while step 2 says it should see some, this is the first
thing to check:

```sql
SELECT COALESCE(activation_status,'(null)'), count(*)
  FROM stg.ask_clientmast
 WHERE lower(btrim(cstatus)) = 'active'
 GROUP BY 1 ORDER BY 2 DESC;
```

Anything other than `Y` or null in that column silently empties the list.

---

## 1. Who may sign in

| # | Do this | Expect |
|---|---|---|
| 1.1 | Sign in at the client door → Branch / AP tab with a `branchho` email for an **active** branch of `ASK-000001` | Code sent, sign-in works |
| 1.2 | Same, for a branch with `ACTIVE = 'N'` | Refused, and the message must **not** say whether that branch exists |
| 1.3 | An email that is on no `branchho` row | Refused with the same wording as 1.2 |
| 1.4 | A branch of a **different firm** | Refused |
| 1.5 | A `branchho` row whose `EMAIL` holds two addresses separated by `;` or `,` — sign in with the **second** one | Works. Free-text email fields are the normal case, not the exception |
| 1.6 | Add that branch code to the desk's blocked list, sign in again | Refused |
| 1.7 | Remove the block, but pick a branch that is `ACTIVE = 'N'`, and try to un-block it | Still refused. The override can take login away, never grant it |

---

## 2. What a branch sees — scoping

`BRANCH_ID` on the client must equal the branch's `BRANCHCODE`, both trimmed and
upper-cased. These codes are chosen to break a comparison that skips either step.

| # | Branch | Expect |
|---|---|---|
| 2.1 | `302` | **529** clients. The largest branch — also 6,921 rows in total, so if the count comes back near 6,900 the active filter is not being applied |
| 2.2 | `CORP` | **286** clients, including the Mutual Fund accounts `FLEXICAP` and `SM92` |
| 2.3 | `HO` | **117** of 781 |
| 2.4 | `KO05` (letter O) | **102** — and must NOT include any `K022` client |
| 2.5 | `K022` (digit zero) | **84** — and must NOT include any `KO05` client |
| 2.6 | `X036` | Exactly **one** client, `D841`. 180 branches look like this; a scoping bug that returns "all" is invisible on a big branch and obvious here |
| 2.7 | `D003`, `W146`, `UP34` | **Zero** clients — every client on these branches is Dormant/Closed. The screen must say "no clients", not error, and not fall back to showing everyone |
| 2.8 | Any branch above | The bid book shows only that branch's bids, **including bids the client placed themselves** |

---

## 3. Who may be bid for

| # | UCC | Status | Expect |
|---|---|---|---|
| 3.1 | `S8454` (branch `302`) | Suspended | Refused: "not active and cannot bid" |
| 3.2 | `H020` (branch `HO`) | Dormant | Refused |
| 3.3 | `AJ0008` (branch `W255`) | Closed | Refused |
| 3.4 | `SUBBNJ62` (branch `302`) | Active | Accepted |
| 3.5 | A UCC that is active but belongs to **another** branch | Refused for a branch/AP session, accepted at the desk |
| 3.6 | A UCC that does not exist at all | "No client found for that UCC" — not a 500 |

Dormant is the important one: 15,251 of 25,000 clients are Dormant, so if the eligibility
check is inverted or skipped, almost everything passes and nothing looks wrong.

---

## 4. Category and the retail cap

| # | Do this | Expect |
|---|---|---|
| 4.1 | Retail bid of exactly ₹2,00,000 | Accepted |
| 4.2 | Retail bid of ₹2,00,000 + one tick | Refused, message names the cap and this bid's value |
| 4.3 | Place a retail bid, then a **second** one on the same scrip for the same client | Refused twice over: one bid per scrip, and the cap message naming what is already live |
| 4.4 | Modify that first bid, keeping the value the same | **Accepted** — the bid being edited must be excluded from its own total |
| 4.5 | Modify it upward, past the cap | Refused |
| 4.6 | HNI bid below ₹2,00,000 | Refused, message gives the minimum and the shares needed at the floor |
| 4.7 | Cut-off bid as HNI | Refused — cut-off is Retail-only |
| 4.8 | Negative or zero quantity, negative price | Refused before anything else |

---

## 5. Windows and the desk's day

| # | Do this | Expect |
|---|---|---|
| 5.1 | Bid inside the Retail window, before the desk cut-off | Accepted |
| 5.2 | Bid after the desk cut-off, window still open | Refused; the dashboard card shows **Desk closed** with the reason, and "Bid on this issue" is disabled |
| 5.3 | Bid on a weekend or a listed holiday | Refused, "reopens on the next trading day" |
| 5.4 | HNI bid on T+1, after the HNI window closed | Refused: "HNI bidding is closed" |
| 5.5 | Move the cut-off later in Settings, retry 5.2 | Accepted. The setting takes effect without a restart |

---

## 6. OTP and the mode switch

| # | Do this | Expect |
|---|---|---|
| 6.1 | Masters → Settings, read the **App Server Settings** banner | Says whether the server is in production, and what is in force for each audience |
| 6.2 | Set *Client, branch and AP codes* to `test`, sign in as a branch | Fixed code, nothing emailed |
| 6.3 | Set it to `real`, sign in again | Real code, emailed, and the branded template arrives |
| 6.4 | Set *Back-office sign-in codes* to `test` while the client one stays `real` | Only the back office takes the fixed code. The two must never move together |
| 6.5 | Desk places a bid for a client with OTP required | The code goes to the **client**, not to the desk |
| 6.6 | Enter a wrong code five times | The challenge is dead; a sixth attempt cannot be used to guess |

If the app server is in production mode, 6.2 and 6.4 must have **no effect** — real codes
regardless, and the banner says so.

---

## 7. Exchange files

| # | Do this | Expect |
|---|---|---|
| 7.1 | Issue on `BOTH`, place a bid without choosing an exchange | Refused: "offered on NSE and BSE, and one bid reaches one of them" |
| 7.2 | Place one NSE bid and one BSE bid on that issue, generate both files | Each bid appears in **exactly one** file. This is the double-submission case — worth checking row counts by hand |
| 7.3 | Generate the NSE file | Column order matches the circular; header row per the setting |
| 7.4 | A bid at cut-off | Price column follows the *Price written for a cut-off bid* setting |

---

## 8. Where I would look first if something is odd

- A branch seeing **everyone** — the scope fell back to "no filter" instead of "nothing".
- A branch seeing **nobody** — `activation_status`, see step 0.
- Counts off by a little on `302` or `CORP` — trimming or case in the `BRANCH_ID` compare.
- A Dormant client accepted — the eligibility check is reading the wrong column.
