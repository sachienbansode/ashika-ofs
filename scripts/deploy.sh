#!/usr/bin/env bash
#
# Deploy the OFS app on the server. Run it FROM the app directory:
#     ./scripts/deploy.sh
#
# Never uses `git pull`: a merge can be blocked by an untracked file (an npm-
# generated lockfile did exactly that), leaving the box on old code while the
# deploy looks like it worked. `fetch` + `reset --hard` makes the working tree
# match the remote outright, every time.
#
# .env is gitignored, so reset --hard does not touch it.
set -euo pipefail

BRANCH="${BRANCH:-main}"
APP="${APP:-ashika-ofs-app}"

cd "$(dirname "$0")/.."
echo "==> $(pwd)  (branch $BRANCH)"

before=$(git rev-parse HEAD)

# fetch BEFORE reset — the stale cached-ref bug has bitten this platform repeatedly
git fetch origin
git reset --hard "origin/$BRANCH"
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
  echo "==> already at $(git log --oneline -1)"
else
  echo "==> $(git log --oneline "$before..$after" | wc -l) new commit(s):"
  git log --oneline "$before..$after" | sed 's/^/    /'
fi

changed() { [ "$before" = "$after" ] && return 1; git diff --name-only "$before" "$after" | grep -q "$1"; }

# Reinstall only when dependencies actually moved — npm ci wipes node_modules.
if [ "$before" = "$after" ] || changed '^package\(-lock\)\?\.json$'; then
  echo "==> npm ci"
  npm ci --omit=dev
else
  echo "==> dependencies unchanged, skipping npm ci"
fi

echo "==> checking .env"
npm run --silent check-env

if [ "$before" = "$after" ] || changed '^db/migrations/'; then
  echo "==> npm run migrate"
  npm run --silent migrate
else
  echo "==> no new migrations"
fi

echo "==> restarting $APP"
pm2 restart "$APP" --update-env >/dev/null
sleep 2

echo "==> health"
curl -fsS localhost:4011/healthz && echo
if curl -fsS localhost:4011/readyz; then
  echo
  echo "==> deployed $(git log --oneline -1)"
else
  echo
  echo "!! /readyz is not healthy — check: pm2 logs $APP --lines 30" >&2
  exit 1
fi
