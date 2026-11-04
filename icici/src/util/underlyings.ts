// The one place that decides which exchange a derivative trades on: SENSEX options are BFO, everything else (NIFTY, stocks) NFO.
export type DerivExchange = 'NFO' | 'BFO';

export function exchangeForIndex(index: string | undefined): DerivExchange {
    return index === 'SENSEX' ? 'BFO' : 'NFO';
}

// The index underlyings whose exchange freeze quantity the order chunking knows (constants.ts: NIFTY_FREEZE_QUANTITY / SENSEX_FREEZE_QUANTITY).
// Anything else is a stock option with its own lot size (e.g. ADANIGREEN 600) and its own freeze limit.
const INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
export function isIndexTsym(tsym: string | undefined): boolean {
    return !!tsym && INDEX_UNDERLYINGS.some((u) => tsym.startsWith(u));
}

// Trading symbols start with the underlying name (e.g. SENSEX2610875000CE).
export function exchangeForTsym(tsym: string | undefined): DerivExchange {
    return tsym?.startsWith('SENSEX') ? 'BFO' : 'NFO';
}
