#!/bin/bash
set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
npm run gapscreener:generate
npm run gapscreener:start
npm run gapscreener:coverorder
