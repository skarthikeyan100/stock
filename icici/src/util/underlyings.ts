// The one place that decides which exchange a derivative trades on: SENSEX options are BFO, everything else (NIFTY, stocks) NFO.
export type DerivExchange = 'NFO' | 'BFO';

export function exchangeForIndex(index: string | undefined): DerivExchange {
    return index === 'SENSEX' ? 'BFO' : 'NFO';
}

// Trading symbols start with the underlying name (e.g. SENSEX2610875000CE).
export function exchangeForTsym(tsym: string | undefined): DerivExchange {
    return tsym?.startsWith('SENSEX') ? 'BFO' : 'NFO';
}
