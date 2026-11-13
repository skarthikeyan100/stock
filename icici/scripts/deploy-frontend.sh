#!/usr/bin/env bash
# Publishes the built frontend (public/) + cloudflare/_worker.js to the Cloudflare Pages repo; a push there deploys it.
#   scripts/deploy-frontend.sh [--build] ["commit message"]
# DIST_REPO = a clone of git@github.com:skarthikeyan100/nivedhatech-app-trading.git (default ~/work/nivedhatech-app-trading).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_REPO="${DIST_REPO:-$HOME/work/nivedhatech-app-trading}"
if [ "${1:-}" = "--build" ]; then (cd "$ROOT/frontend" && npm run build); shift; fi
MSG="${1:-Frontend build $(date -u +%Y-%m-%dT%H:%MZ) from $(git -C "$ROOT" rev-parse --short HEAD)}"
if [ ! -d "$DIST_REPO/.git" ]; then git clone git@github.com:skarthikeyan100/nivedhatech-app-trading.git "$DIST_REPO"; fi
cd "$DIST_REPO"
git pull --ff-only 2>/dev/null || true
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$ROOT/public/." .
cp "$ROOT/cloudflare/_worker.js" _worker.js
git add -A
if git diff --cached --quiet; then echo "nothing to deploy"; exit 0; fi
git commit -q -m "$MSG"
git push origin HEAD:main
echo "pushed: Cloudflare Pages deploys from this push"
