# Open items: server-core (everything else fixed in 8d53d62)
Decided by user: no ANT login `state` check (item 12 closed); no invoices exist so counter needs no seeding.
Optional, not a code item: set CF_ORIGIN_SECRET + a Cloudflare Transform Rule to enable the origin-secret check.

29. [SEV: med] src/monitor.ts:166 (+ constants.ts USER_LOSS_LIMIT fallback 150,000,000) - getInstrumentLotSize hardcodes lots and defaults every other symbol (SENSEX 20, BSE) to 65, so SENSEX lot limit allows ~3x; users missing from settings cache effectively have no loss limit (fail-open). Fix: lot-size table incl. SENSEX/BANKNIFTY/FINNIFTY (or from contract master) and throw/deny for unknown; fall back to a conservative loss limit (e.g. 0 or default 15000) instead of 150,000,000. [PARTIAL-DONE: lot sizes (SENSEX 20, unknown conservative). USER_LOSS_LIMIT fallback left at 150000000 on purpose: strategy pseudo-users (BulkPcr-NIFTY etc.) have no user doc and rely on it; needs a human decision]
