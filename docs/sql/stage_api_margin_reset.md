# Nightly margin reset — what the Stage API scheduler calls

Ashika's rule: **every client's available margin starts the day at zero**, and the
day's figures are uploaded before bidding. A margin left over from last week must
never be able to fund today's bid, and the only way to guarantee that is to clear
them rather than trust that someone re-uploaded.

The **schedule lives in the Stage API admin module**, not in OFS. One scheduler for
the platform is easier to see, to audit and to silence than a timer hidden inside
each application — and a job that fails is visible where the operations team already
looks.

## The call

```
POST https://ofs-bids.ashikagroup.com/api/margin/reset
Cookie: <an OFS session>            (or Authorization: Bearer <token>)
Content-Type: application/json

{ "note": "nightly reset" }
```

Run it at **00:00 IST**, every day including non-trading days. Zeroing a margin on a
holiday costs nothing; leaving one live does.

| Field | Meaning |
|---|---|
| `note` | Goes on every history row. Say where the reset came from. |
| `delete_rows` | `"1"` removes the rows instead of setting them to zero. Not recommended: a client with no row and a client at zero behave identically for bidding, and the row is what shows the desk that the morning upload has not happened yet. |

The response says how many clients were changed:

```json
{ "ok": true, "clients": 412, "rows_deleted": false, "at": "2026-09-12T18:30:00.000Z" }
```

## What it writes

Every changed client gets its own row in `ofs.ofs_margin_log` with the old value,
zero, the note and the actor — so the morning after, "why was this client at zero?"
has an answer with a name and a time against it. One entry in `ofs.ofs_audit` records
the run as a whole.

Rows already at zero are not touched and not logged; a reset that runs twice does not
fill the history with nothing happening.

## Permissions

The endpoint needs the OFS grant (`ofs-masters`), so the scheduler signs in as a
service account with the **OFS-Backoffice** role. Create it with
`docs/sql/ofs_backoffice_role.sql` under an address such as
`ofs.scheduler@ashikagroup.com`, and note that OFS access is all-or-nothing — this
account can also see unmasked client PII, so treat its credentials accordingly.

## If it does not run

Nothing breaks and nothing is silently wrong: the previous day's margins simply stand
until the morning upload replaces them. That is the failure worth knowing about,
because it is invisible from the bidding screen — the margin figures look normal.
Have the scheduler alert on a non-2xx, and check **Masters → Margins** for an
`updated_at` that is not today.

The same reset is available by hand at **Masters → Margins → Zero all margins**.
