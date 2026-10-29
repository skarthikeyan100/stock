import Log from '../../util/Log';
import { estimateOptionPricesBatch } from './antExecutor';

// The contract whose premium clears `minPremium`, walking OTM depth 0-4 from the ATM strike and then ITM depth 1-4 (first hit wins),
// skipping `excludeStrikes`. Premiums come from ANT's option chain (the common price source for every broker); `resolve` turns the
// chosen strike into that broker's own contract record. Shared by every executor's getContractByPriceRange so the strike priority
// and the error are identical across brokers.
export async function pickContractByPremium<T extends object>(
    underlyingLtp: number,
    optionType: 'CE' | 'PE',
    index: 'NIFTY' | 'SENSEX',
    minPremium: number,
    excludeStrikes: Set<number>,
    resolve: (strike: number, antToken: string) => Promise<T> | T,
): Promise<T & { strike: number; premium: number; antToken: string }> {
    const strikeStep = index === 'SENSEX' ? 100 : 50;
    const atmStrike = Math.round(underlyingLtp / strikeStep) * strikeStep;

    const candidateStrikes: number[] = [];
    for (let depth = 0; depth < 5; depth++) {
        const strike = optionType === 'CE' ? atmStrike + depth * strikeStep : atmStrike - depth * strikeStep;
        if (!excludeStrikes.has(strike)) candidateStrikes.push(strike);
    }
    for (let depth = 1; depth < 5; depth++) {
        const strike = optionType === 'CE' ? atmStrike - depth * strikeStep : atmStrike + depth * strikeStep;
        if (!excludeStrikes.has(strike)) candidateStrikes.push(strike);
    }

    const premiumData = await estimateOptionPricesBatch(index, candidateStrikes.map((strike) => ({ strike, optionType })));

    for (const strike of candidateStrikes) {
        const data = premiumData.get(`${strike}_${optionType}`);
        if (data == null || data.premium < minPremium) continue;
        try {
            const contract = await resolve(strike, data.antToken);
            return { ...contract, strike, premium: data.premium, antToken: data.antToken };
        } catch (e) {
            Log.log('[order] contract resolution failed for a priced-in strike:', strike, optionType, e);
        }
    }

    throw new Error(`No ${index} ${optionType} contract found with premium >= ${minPremium} (underlyingLtp=${underlyingLtp})`);
}
