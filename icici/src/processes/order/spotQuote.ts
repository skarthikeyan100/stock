import ANT from '../../ant/ANT';

// Live spot LTP of an index, for the unsized manual-buy paths that must pick an ATM strike but have no tick to read. Throws
// (never returns 0): a 0 spot made findATMOption resolve a nonsense contract.
const INDEX_SPOT: Record<string, { exchange: string; token: string }> = {
    NIFTY: { exchange: 'NSE', token: '26000' },
    SENSEX: { exchange: 'BSE', token: '1' },
};

export async function getSpotLtp(index: string): Promise<number> {
    const ref = INDEX_SPOT[index];
    if (!ref) throw new Error(`No spot-quote reference for index ${index}`);
    let ltp: number;
    try {
        ltp = (await ANT.getInstance().getLiveQuote(ref.exchange, ref.token)).ltp;
    } catch (e) {
        ltp = await ANT.getInstance().getQuote(ref.exchange, ref.token);
    }
    if (!(ltp > 0)) throw new Error(`Spot quote for ${index} unavailable - manual buy not placed`);
    return ltp;
}
