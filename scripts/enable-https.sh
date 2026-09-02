#!/usr/bin/env bash
# Flip the app from plain HTTP to HTTPS, once a certificate is actually in place.
#
# Run it AFTER `certbot --nginx -d <domain>` has succeeded. It refuses otherwise,
# because turning these on without a certificate takes the site down rather than
# securing it: COOKIE_SECURE=true means the browser stops sending the session
# cookie over HTTP, and upgrade-insecure-requests makes the page ask for assets
# over a port that is not listening.
#
#   bash scripts/enable-https.sh ofs-bids.ashikagroup.com
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
APP_NAME="${PM2_APP:-ashika-ofs-app}"

[ -n "$DOMAIN" ] || { echo "usage: bash scripts/enable-https.sh <domain>" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "!! no .env at $ENV_FILE" >&2; exit 1; }

# The real test is whether TLS answers, not whether this user can read the key.
# /etc/letsencrypt/live is mode 700, so a plain `test -f` here is false for anyone
# but root even when the certificate exists — checking the file was the wrong gate.
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ -r "$CERT" ] || sudo -n test -f "$CERT" 2>/dev/null; then
  echo "==> certificate present: $CERT"
else
  echo "==> cannot read $CERT (root-only, or absent) — relying on the live TLS check"
fi

# Authoritative: does the site actually serve HTTPS right now?
if ! curl -fsS --max-time 15 "https://$DOMAIN/healthz" >/dev/null; then
  echo "!! https://$DOMAIN/healthz did not answer over TLS — not changing anything." >&2
  echo "   If the certificate was just issued:  sudo nginx -t && sudo systemctl reload nginx" >&2
  echo "   If it was never issued:              sudo certbot --nginx -d $DOMAIN" >&2
  exit 1
fi
echo "==> https://$DOMAIN is serving TLS"

cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"

set_env() {                       # set_env KEY value  — replace in place or append
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
  echo "   $key=$val"
}

echo "==> updating $ENV_FILE"
set_env APP_URL       "https://$DOMAIN"
set_env CORS_ORIGINS  "https://$DOMAIN"
set_env COOKIE_SECURE true
set_env FORCE_HTTPS   true

echo "==> restarting $APP_NAME"
pm2 restart "$APP_NAME" --update-env >/dev/null
sleep 2

echo "==> checking"
curl -fsS --max-time 15 "https://$DOMAIN/readyz" && echo
curl -sSI --max-time 15 "https://$DOMAIN/" | grep -iE '^(HTTP/|strict-transport|content-security)' || true
echo
echo "Done. http://$DOMAIN now redirects to https, the session cookie is TLS-only,"
echo "and HSTS is on. Renewal is certbot's timer: systemctl list-timers | grep certbot"
