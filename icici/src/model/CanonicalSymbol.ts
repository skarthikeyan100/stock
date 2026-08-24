// Broker-agnostic option identifier: underlying + strike + right, no expiry.
// Expiry is always resolved to the nearest one at lookup time (see each
// broker's ContractMaster) - the user can't pick a date today; a future
// `expiryOffset` param (0 = nearest, 1 = next, ...) is where "choose the next
// expiry" would plug in later, per product direction.

export interface CanonicalSymbol {
    symbol: string;
    strike: number;
    optionType: 'CE' | 'PE';
}

// e.g. { symbol: 'NIFTY', strike: 24100, optionType: 'CE' } <-> 'NIFTY_24100_CE'
export function formatCanonicalSymbol(c: CanonicalSymbol): string {
    return `${c.symbol}_${c.strike}_${c.optionType}`;
}

export function parseCanonicalSymbol(s: string): CanonicalSymbol {
    const parts = s.trim().split('_');
    if (parts.length !== 3) throw new Error(`Malformed canonical symbol: ${s}`);
    const [symbol, strikeStr, optionType] = parts;
    const strike = Number(strikeStr);
    if (!symbol || Number.isNaN(strike) || (optionType !== 'CE' && optionType !== 'PE')) {
        throw new Error(`Malformed canonical symbol: ${s}`);
    }
    return { symbol, strike, optionType };
}
