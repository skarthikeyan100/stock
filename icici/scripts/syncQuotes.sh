#!/bin/bash
set -euo pipefail

# Sync the NiftyQuote collection (the one the code reads/writes - see src/model/model.ts NiftyQuote.fromAnt and /replay)
# from remote MongoDB (karthik@karthik) to local MongoDB.
# Remote: stocks.NiftyQuote
# Local:  stocks.NiftyQuote  (restored into a temp collection first, then swapped in, so a failed
#         transfer never leaves the local collection dropped/empty)

REMOTE_HOST="karthik@karthik"
REMOTE_DB="stocks"
COLLECTION="NiftyQuote"
TMP_COLLECTION="${COLLECTION}_sync_tmp"
LOCAL_DB="stocks"

echo "Syncing '$COLLECTION' collection from $REMOTE_HOST..."

ssh "$REMOTE_HOST" \
    mongodump \
        --db "$REMOTE_DB" \
        --collection "$COLLECTION" \
        --archive \
    | mongorestore \
        --archive \
        --nsFrom "${LOCAL_DB}.${COLLECTION}" \
        --nsTo "${LOCAL_DB}.${TMP_COLLECTION}" \
        --drop \
        --quiet

# Swap only after the restore fully succeeded (set -e + pipefail abort above otherwise).
mongosh --quiet "mongodb://localhost:27017/${LOCAL_DB}" --eval "db.getCollection('${TMP_COLLECTION}').renameCollection('${COLLECTION}', true)"

echo "Sync complete: $REMOTE_DB.$COLLECTION -> local $LOCAL_DB.$COLLECTION"
