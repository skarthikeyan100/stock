#!/bin/bash
set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# Build first: these npm scripts run dist/, which is stale when no orchestrator (tsc -w) is running (unchanged output never restarts a child).
npx tsc
npm run gapscreener:generate
npm run gapscreener:start
npm run gapscreener:coverorder
