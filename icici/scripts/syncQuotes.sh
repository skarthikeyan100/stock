#!/bin/bash

# Sync Quote collection from remote MongoDB (karthik@karthik) to local MongoDB
# Remote: stocks.Quote
# Local:  stocks.Quote

REMOTE_HOST="karthik@karthik"
REMOTE_DB="stocks"
COLLECTION="Quote"
LOCAL_DB="stocks"

echo "Syncing '$COLLECTION' collection from $REMOTE_HOST..."

ssh "$REMOTE_HOST" \
    mongodump \
        --db "$REMOTE_DB" \
        --collection "$COLLECTION" \
        --archive \
    | mongorestore \
        --archive \
        --db "$LOCAL_DB" \
        --collection "$COLLECTION" \
        --drop \
        --quiet

if [ $? -eq 0 ]; then
    echo "Sync complete: $REMOTE_DB.$COLLECTION → local $LOCAL_DB.$COLLECTION"
else
    echo "Sync failed." >&2
    exit 1
fi
