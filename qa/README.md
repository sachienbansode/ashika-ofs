# Ashika OFS — front-end test suite

Drives the three shells in a real browser and writes the run to Excel.

**It does not touch the app.** Its own `package.json`, its own `node_modules`,
nothing under `lib/`, `routes/`, `public/`, `db/` or `server.js` is changed, and
`npm ci --omit=dev` on the app server never sees it.

## Once

```powershell
cd "D:\sachin b\projects\OFS\qa"
npm install
npx playwright install chromium
npm run make-plan
```

`make-plan` writes `plan/OFS_Test_Plan_TEMPLATE.xlsx`. Fill it in, **save it
outside the repo** — it holds live passwords — and pass its path with `--book`.

## Each run

```powershell
npm test -- --book "C:\Ashika\OFS_Test_Plan.xlsx" --env UAT
npm test -- --book "C:\Ashika\OFS_Test_Plan.xlsx" --env PROD --only desk
```

`--only desk|ap|client` narrows to one role. `HEADLESS=1` hides the window, but
only once every user has `otp_mode=static` — client and AP sign-in pause for a
person to type the real code into the visible browser.

Out comes `results/OFS_Test_Results_<ENV>_<when>.xlsx`: a Summary, a Failures
sheet when there are any, every case, and one sheet per group. Screenshots,
video and a trace are kept for failures only.

## The workbook

| Sheet | |
|---|---|
| `Environment` | `name`, `base_url`, `writes_allowed`, `otp_wait_seconds`. One base URL per row — `/backoffice`, `/partner` and `/` are derived, because they are fixed mount points in `server.js`. |
| `Users` | `role` (desk / ap / client), `identifier`, `password` (desk only), `branch_code`, `otp_mode`, `static_otp`. |
| `TestData` | `issue_prefix`, `margin_uccs`, `bid_ucc`, `search_ucc`, `search_name`. |

A blank row ends a sheet — the notes below the data are notes, not records.

## Guard rails

- `writes_allowed` defaults to off. Render tests ignore it; anything that changes
  data is skipped unless the Environment row says yes.
- With writes on, the runner **refuses to start between 09:00 and 16:00 IST on a
  trading day**. A test bid is contained by being withdrawn in the same run, and
  that only holds while nobody is bidding.
- `retries: 0`. A retry re-runs the whole test, and a test that placed a bid
  before it failed would place a second one.

## Adding a case

Selectors live in `pages/`, never in a spec — that is what keeps a hundred cases
maintainable when an id changes. The case id goes at the front of the test title
(`BO-REN-12  …`) because the reporter builds the plan from the titles, so a
rename cannot silently renumber the workbook. State the expectation with

```js
test.info().annotations.push({ type: 'expected', description: '…' });
```

or the case arrives in the Excel with an empty Expected column and nobody can
review it.
