# `ofs_test_issues.csv` — twelve issues, each testing something different

Import at **Masters → Issues → Import issues CSV**. Windows are set relative to the
day the file was generated: rows 1–9 and 12 open **today**, row 10 opens in three
days, row 11 closed last week. Regenerate the dates by hand if you import it later.

| # | Symbol | What it is there to prove |
|---|---|---|
| 1 | `TESTBOTH` | The ordinary case. On BOTH exchanges, so **Place bid must make you choose** NSE or BSE, and only that exchange's file may carry the bid. |
| 2 | `TESTNSE` | NSE only. Its bids must **not** appear in the BSE file, and the Exchange field must be fixed, not a choice. |
| 3 | `TESTBSE` | BSE only, and the mirror of the above. |
| 4 | `TESTLOT` | Lot of 100. Every quantity must be a multiple of 100, and the suggested bid must round to it. |
| 5 | `TESTNOCUT` | `cutoff_flag = N`. **Cut-off must disappear from the price-type list even for Retail.** |
| 6 | `TESTCUTMIN` | Retail cut-off min (315) above the floor (300). Retail must be held to 315, HNI to 300. |
| 7 | `TESTNOFLOOR` | **No floor published** (NSE FAQ Q12). Must import, show a blank floor, and refuse a cut-off bid because it cannot be valued against the ₹2 lakh cap. |
| 8 | `TESTHIGH` | ₹19,500 a share. One retail lot is most of the cap — the suggested retail quantity should be 10. |
| 9 | `TESTPENNY` | ₹2.25 a share, tick 0.01. The HNI minimum needs ~88,889 shares; check the rounding goes **up**. |
| 10 | `TESTFUTURE` | Opens in three days. Must read **Upcoming** and refuse a bid today. |
| 11 | `TESTCLOSED` | Closed last week. Must be **hidden from the dashboard** unless "Show closed too" is ticked, absent from the Place bid dropdown, and archivable. |
| 12 | `TESTSAMEDAY` | Both legs open the same day. The dropdown must say which window is closing, and both categories must be biddable. |

## Worth checking once they are in

**Exchange routing.** Place a bid on `TESTBOTH` choosing NSE, and another choosing
BSE. Generate both files under Exchange files: each bid must appear in exactly one.
Before this build they appeared in both, which would have submitted the client twice.

**The unrouted warning.** Any bid placed on a BOTH issue before this change has no
exchange. The preview names those rather than dropping them — a client who bid and is
in neither file is the failure nobody notices until allotment day.

**The cap and the minimum.** On `TESTHIGH`, a retail bid of 11 shares breaches ₹2
lakh and must be refused. On `TESTPENNY`, an HNI bid below ~88,889 shares is under the
non-retail minimum and must be refused.

## Columns

`symbol, company, isin, exchange, bse_scrip_code, series, floor_price, cut_price_min,
tick, lot, issue_qty, retail_qty, discount_pct, cutoff_flag, hni_open, hni_close,
ret_open, ret_close`

Required: `symbol, company, isin, hni_open, hni_close, ret_open, ret_close`.
`floor_price` may be blank. `bse_scrip_code` is required for a BSE or BOTH issue —
without it the BSE file is built with an empty scrip code and the exchange refuses it.
`cutoff_flag` takes `Y`/`N` (blank means allowed). Times are IST.
