# End-to-end scenarios

Drives the real application over HTTP against two real PostgreSQL databases.
Not assertions over source — the server, the routes and the SQL all run.

## What it needs

A PostgreSQL with two databases (`ofs_bids`, `uat_ananta_staging`), the OFS
migrations applied to the first, and LD-shaped fixtures in the second:
`dwh.tbl_user_info`, `stg.ask_clientmast`, `stg.branchho`, and the
`"admin-staging-api"` users/roles/page_registry tables. `e2e/fixtures.sql`
creates and seeds them.

## Running it

    set -a; . e2e/env.example; set +a
    node db/migrate.js
    node server.js &
    node e2e/run.js

`OFS_OTP_TEST_MODE=true` is required: it makes the client-confirmation code come
back in the response instead of being emailed, which is what lets the bid path run
without SMTP. That mode is hard-floored off when `NODE_ENV=production`
(`lib/otp.isProduction`), and scenario PRD-1 proves it.

Results are written to `/tmp/e2e-results.json` as well as stdout.

## What it covers

Sign-in and session separation, the issue master, margin (set, bulk, duplicate
handling, history, removal, zero-all), the whole bid lifecycle including the
client's confirmation, every rule the desk relies on (SEBI retail cap, non-retail
minimum, floor, tick, margin, category, exchange), exchange-file generation for
both exchanges and for an earlier day, branch/AP scope isolation and PII masking,
settings and their defaults, the audit trail, withdrawal, and the security
headers.

## Why it exists

Three faults were found the first time it ran that 450 unit tests had not:
zero-all violated a CHECK constraint and had never worked; a malformed ISIN was
accepted at the issue master and only refused days later at file time; and the
sign-in page still revealed whether a client code existed, because a seeded
database row beat the code default. All three needed the real schema to surface.
