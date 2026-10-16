import Log from '../util/Log';
import ANT from '../ant/ANT';
import AntContractMaster from '../ant/AntContractMaster';
import OrderClient from '../processes/strategies/OrderClient';
import { LegBrokerOps } from './LegBrokerOps';

// BulkPcrStrategy's hedge tree trades on ANT, not Zerodha/Breeze - this is the
// LegBrokerOps implementation LegManager uses for it (see BulkPcrStrategy.ts's
// hedgeCfg/wiring). Reused instead of the Zerodha/Breeze 'Bare' IPC family
// (OrderClient.getContractByPriceRangeBare/buyContractBare/etc) because:
//  - BulkPcrStrategy trades on ANT, and those IPCs route via
//    bookkeeping.getUserBroker(userId), which only ever resolves Zerodha/Breeze.
//  - ANT has no contract-by-price-range lookup of its own - the Zerodha/Breeze
//    getContractByPriceRangeBare path would pick the wrong instrument entirely.
const NIFTY_STRIKE_STEP = 50;

async function pickContract(
    userId: string,
    underlyingLtp: number,
    optionType: 'CE' | 'PE',
    minPremium: number,
    excludeStrikes: number[]
): ReturnType<LegBrokerOps['pickContract']> {
    const chain = await ANT.getInstance().getOptionChain('NIFTY');
    const bySide = optionType === 'CE' ? 'ce' : 'pe';
    const excluded = new Set(excludeStrikes);

    // Mirrors getContractByPriceRangeOnZerodha's exact priority order (ATM, then
    // OTM depth 1-4, then ITM depth 1-4 - not a flat "nearest by absolute distance"
    // search) so a hedge contract is picked the same way every other
    // price-range-driven entry in this codebase already is. See that function's
    // comment in zerodhaExecutor.ts.
    const atmStrike = Math.round(underlyingLtp / NIFTY_STRIKE_STEP) * NIFTY_STRIKE_STEP;
    const candidateStrikes: number[] = [];
    for (let depth = 0; depth < 5; depth++) {
        const strike = optionType === 'CE' ? atmStrike + depth * NIFTY_STRIKE_STEP : atmStrike - depth * NIFTY_STRIKE_STEP;
        if (!excluded.has(strike)) candidateStrikes.push(strike);
    }
    for (let depth = 1; depth < 5; depth++) {
        const strike = optionType === 'CE' ? atmStrike - depth * NIFTY_STRIKE_STEP : atmStrike + depth * NIFTY_STRIKE_STEP;
        if (!excluded.has(strike)) candidateStrikes.push(strike);
    }

    const rowByStrike = new Map(chain.map((row) => [row.strike, row]));
    for (const strike of candidateStrikes) {
        const row = rowByStrike.get(strike);
        if (!row) continue;
        const side = row[bySide];
        if (!(side.ltp >= minPremium)) continue;
        const m = AntContractMaster.getInstance().findByToken(String(side.token));
        if (!m) throw new Error(`pickContract: no ANT contract master entry for token ${side.token} (strike=${strike} ${optionType})`);
        return { tradingSymbol: m.tradingSymbol, token: String(side.token), exchange: m.exch === 'BFO' ? 'BFO' : 'NFO', strike, premium: side.ltp };
    }

    throw new Error(`pickContract: no ANT strike with premium >= ${minPremium} (underlyingLtp=${underlyingLtp}, ${optionType})`);
}

async function buy(userId: string, tradingSymbol: string, token: string, quantity: number, exchange: 'NFO' | 'BFO', _premiumHint: number) {
    try {
        return await OrderClient.getInstance().antBuyContractBare(userId, { tradingSymbol, instrumentId: token, quantity, exchange });
    } catch (e: any) {
        const message = typeof e?.message === 'string' ? e.message : String(e);
        if (message.includes('did not complete within')) {
            // The fill wait timed out - the order may still be live at the broker.
            // Never safe to retry (double-buy risk) or silently swallow (an
            // unmonitored live position). Rethrown with a distinguishing prefix so
            // the caller (LegManager's trySpawnLevel -> deps.onSpawnBuyError) can
            // flag this tree for manual review instead of treating it as an
            // ordinary, retryable spawn failure.
            Log.log(`[antLegOps] ALERT: buy for ${tradingSymbol} qty=${quantity} unconfirmed - manual review needed (order may be live at the broker): ${message}`);
            throw new Error(`[HEDGE_UNCONFIRMED] ${message}`);
        }
        throw e;
    }
}

async function sell(userId: string, tradingSymbol: string, _token: string, quantity: number, exchange: 'NFO' | 'BFO') {
    return OrderClient.getInstance().antSquareOffBare(userId, { tradingSymbol, quantity, exchange });
}

async function cancel(userId: string, orderId: string): Promise<void> {
    await OrderClient.getInstance().antCancelOrderBare(userId, orderId);
}

async function buyLimit(): ReturnType<LegBrokerOps['buyLimit']> {
    // Unreachable while BulkPcrStrategy's hedge tree keeps refillEnabled: false
    // (see BulkPcrStrategy.hedgeCfg) - ANT has no resting-limit-buy bare op wired
    // up for this path yet.
    Log.log('[antLegOps] ALERT: buyLimit called on the ANT hedge path - refill should be disabled (refillEnabled: false)');
    throw new Error('buyLimit not supported on ANT hedge path (refill disabled)');
}

export const antLegOps: LegBrokerOps = { pickContract, buy, sell, cancel, buyLimit };
