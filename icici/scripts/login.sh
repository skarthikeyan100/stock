#!/bin/bash
# Logs in to Shoonya, ANT, Kite and Breeze: pre-fills user id and password from broker-credentials.json in Chrome
# and asks for each broker's OTP in this terminal, one at a time. See login.js.
# Usage: login.sh [--dry-run] [prism|ant|kite|breeze ...]
exec node "$(dirname "$(readlink -f "$0")")/login.js" "$@"
