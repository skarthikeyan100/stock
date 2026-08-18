#!/bin/bash

set -e

PRISM_URL="http://localhost:3000/prism/login"
ANT_URL="http://localhost:3000/ant/login"
KITE_URL="http://localhost:3000/kite/login"

if ! command -v firefox &> /dev/null; then
    echo "Error: firefox is not installed."
    exit 1
fi

echo "Opening Prism (Shoonya) login: $PRISM_URL"
firefox "$PRISM_URL" &

echo "Opening ANT (AliceBlue) login: $ANT_URL"
firefox "$ANT_URL" &

echo "Opening Kite (Zerodha) login: $KITE_URL"
firefox "$KITE_URL" &
