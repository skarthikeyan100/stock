#!/bin/bash

set -e

PRISM_URL="http://localhost:3000/prism/login"
ANT_URL="http://localhost:3000/ant/login"
KITE_URL="http://localhost:3000/kite/login"

if ! command -v firefox &> /dev/null; then
    echo "Error: firefox is not installed."
    exit 1
fi

# GTK_MODULES=gail:atk-bridge (set at the session/desktop level, not by this repo)
# makes Firefox print a harmless "Not loading module 'atk-bridge'..." message on
# every launch, since GTK3+ already provides that functionality natively.
# Unset it just for these launches rather than touching the session-wide env var,
# in case something else relies on it for accessibility.

echo "Opening Prism (Shoonya) login: $PRISM_URL"
env -u GTK_MODULES firefox "$PRISM_URL" &

echo "Opening ANT (AliceBlue) login: $ANT_URL"
env -u GTK_MODULES firefox "$ANT_URL" &

echo "Opening Kite (Zerodha) login: $KITE_URL"
env -u GTK_MODULES firefox "$KITE_URL" &
