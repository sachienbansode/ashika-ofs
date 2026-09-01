# Platform patch — "OFS Desk" single sign-on

The OFS app deliberately has no login form. Staff authenticate at the existing
portal (password, plus OTP where the account requires it); the portal then hands
them to OFS with a short-lived ticket.

```
portal (authenticated)
  └── GET /api/sso/ofs          ← mints a 60s single-use ticket
        └── 302 → http://<ofs>/auth/sso?t=<ticket>
              └── OFS verifies, redeems, sets its own ofs_session cookie → /
```

## Why a ticket rather than sharing the portal's cookie

The portal's `ashika_session` cookie is scoped to the portal's origin. A browser
will not send it to the OFS app on a different host, so OFS must issue its own
session. Copying the cookie across would mean widening its scope to both apps —
a bigger blast radius than a 60-second ticket.

## What the ticket does and does not carry

It asserts **identity** (`sub`, `email`, `sid`) and **that MFA was satisfied**.
It carries no roles or permissions: OFS re-reads those from
`"admin-staging-api".users` and `roles` on every redemption, so a disabled account
or a revoked grant takes effect at once rather than lasting until the ticket expires.

## Defences

| Risk | Countered by |
|---|---|
| Ticket replayed from history / a proxy log / Referer | Single use, enforced by a primary-key insert in `ofs.ofs_sso_ticket` |
| Ticket captured and used later | 60-second lifetime; OFS refuses any ticket minted with a TTL over 300s |
| An OFS session token replayed as a ticket, or the reverse | Distinct secret (`OFS_SSO_SECRET`), plus `aud` and `typ` claims |
| Anonymous caller minting tickets | The route is mounted **behind `authMiddleware`** |
| User signs in elsewhere, old OFS session lives on | Ticket carries `sid`; OFS checks it against `users.active_sid` on every request |
| Guessing loop against the exchange | Rate limited, 20/min per IP |

## Steps

1. Copy `routes-sso-ofs.js` into the platform repo as `routes/ssoOfs.js`.
2. In `app.js`, after `authMiddleware` is in scope:
   ```js
   app.use('/api/sso/ofs', authMiddleware, require('./routes/ssoOfs'));
   ```
   Mounting it without `authMiddleware` turns it into an open ticket vending
   machine — that mount is the whole security boundary.
3. Generate one secret and put the **same value** in both apps' `.env`:
   ```bash
   openssl rand -base64 48
   ```
   ```
   # platform .env                    # OFS .env
   OFS_SSO_SECRET=<value>             OFS_SSO_SECRET=<same value>
   OFS_APP_URL=http://20.244.33.142   PORTAL_URL=https://staging-api-uat.ashikagroup.com
   ```
4. Add a portal nav link: `<a href="/api/sso/ofs" target="_blank" rel="noopener">OFS Desk</a>`
5. Restart both apps.

## Verifying

- Signed in to the portal, hit `/api/sso/ofs` → you land on the OFS desk, signed in.
- Press Back and re-load the `/auth/sso?t=...` URL → refused, "already been used".
- Wait 60s before redeeming → refused, "expired".
- Sign in to the portal again in another browser, then use the OFS tab → next
  request 401s with `session_superseded`, because `active_sid` rotated.
