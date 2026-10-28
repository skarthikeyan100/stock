import Log from '../util/Log';
import ANT from '../ant/ANT';
import AntContractMaster from '../ant/AntContractMaster';
import OrderClient from '../processes/strategies/OrderClient';
import { LegBrokerOps } from './LegBrokerOps';
import { HEDGE_UNCONFIRMED_TAG } from '../ipc/orderProtocol';

// LegBrokerOps implementation LegManager uses for an instance that trades on ANT (ContinuousStrategy with `broker: ant`;
// BulkPcrStrategy's old hedge tree used it before the pair rewrite). Orders go through the generic 'Bare' IPC family with an explicit
// `broker: 'ant'` (the default ops route by the user's configured broker instead). The contract pick is ANT's own: ANT has no
// contract-by-price-range lookup, so the strike is chosen here from its option chain.
const NIFTY_STRIKE_STEP = 50;

interface ChainSide { ltp: number; token: number | string }
interface ChainRow { strike: number; ce: ChainSide; pe: ChainSide }

// Pure strike choice: ATM first, then OTM depth 1-4, then ITM depth 1-4, first one whose premium clears minPremium.
export function pickStrikeFromChain(chain: ChainRow[], underlyingLtp: number, optionType: 'CE' | 'PE', minPremium: number, excludeStrikes: number[]): { strike: number; side: ChainSide } {
    const bySide = optionType === 'CE' ? 'ce' : 'pe';
    const excluded = new Set(excludeStrikes);

    // Mirrors getContractByPriceRangeOnZerodha's exact priority order (ATM, then
    // OTM depth 1-4, then ITM depth 1-4 - not a flat "nearest by absolute distance"
    // search) so a leg contract is picked the same way every other
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
        return { strike, side };
    }
    throw new Error(`pickContract: no ANT strike with premium >= ${minPremium} (underlyingLtp=${underlyingLtp}, ${optionType})`);
}

async function pickContract(
    _userId: string,
    underlyingLtp: number,
    optionType: 'CE' | 'PE',
    minPremium: number,
    excludeStrikes: number[]
): ReturnType<LegBrokerOps['pickContract']> {
    const chain = await ANT.getInstance().getOptionChain('NIFTY');
    const { strike, side } = pickStrikeFromChain(chain as unknown as ChainRow[], underlyingLtp, optionType, minPremium, excludeStrikes);
    const m = AntContractMaster.getInstance().findByToken(String(side.token));
    if (!m) throw new Error(`pickContract: no ANT contract master entry for token ${side.token} (strike=${strike} ${optionType})`);
    return { tradingSymbol: m.tradingSymbol, token: String(side.token), exchange: m.exch === 'BFO' ? 'BFO' : 'NFO', strike, premium: side.ltp };
}

async function buy(userId: string, tradingSymbol: string, token: string, quantity: number, exchange: 'NFO' | 'BFO', _premiumHint: number) {
    try {
        return await OrderClient.getInstance().buyContractBare(userId, tradingSymbol, token, quantity, exchange, undefined, 'ant');
    } catch (e: any) {
        const message = typeof e?.message === 'string' ? e.message : String(e);
        // "fill status unresolved" is resolveUnconfirmedAntBuy's (antExecutor.ts)
        // actual thrown message for every genuinely ambiguous outcome - a timed-out
        // waitForFill is caught INSIDE enterPosition and falls through to a REST
        // fallback / resolveUnconfirmedAntBuy first, so "did not complete within"
        // (waitForFill's own internal message) never reaches this catch; checking
        // for it here never matched and let an ambiguous fill retry as an ordinary
        // spawn failure - exactly the double-buy risk this check exists to prevent.
        if (message.includes('fill status unresolved')) {
            // The order's true fill outcome could not be confirmed - it may still be
            // live at the broker. Never safe to retry (double-buy risk) or silently
            // swallow (an unmonitored live position). Rethrown with a distinguishing
            // prefix so the caller (LegManager's trySpawnLevel -> deps.onSpawnBuyError)
            // can flag this tree for manual review instead of treating it as an
            // ordinary, retryable spawn failure.
            Log.log(`[antLegOps] ALERT: buy for ${tradingSymbol} qty=${quantity} unconfirmed - manual review needed (order may be live at the broker): ${message}`);
            throw new Error(`${HEDGE_UNCONFIRMED_TAG} ${message}`);
        }
        throw e;
    }
}

// Chunked: one unchunked order above the exchange freeze quantity (1755 for NIFTY) is rejected outright, leaving the leg open.
async function sell(userId: string, tradingSymbol: string, _token: string, quantity: number, _exchange: 'NFO' | 'BFO') {
    const res = await OrderClient.getInstance().chunkedSquareOff(userId, { tradingSymbol, quantity, broker: 'ant' });
    // A stopped chunk run (exit placed, fill unconfirmed) returns normally with less than asked. LegManager treats a normal return as
    // fully sold and forgets the leg, so a short result must surface as a failure instead.
    if (Number(res?.quantity ?? quantity) < quantity) {
        throw new Error(`ANT sell of ${tradingSymbol}: only ${res.quantity}/${quantity} confirmed sold (rest unconfirmed, still being re-priced)`);
    }
    return res;
}

async function cancel(userId: string, orderId: string, exchange?: 'NFO' | 'BFO'): Promise<void> {
    await OrderClient.getInstance().cancelOrderBare(userId, orderId, exchange, 'ant');
}

async function buyLimit(userId: string, tradingSymbol: string, token: string, quantity: number, exchange: 'NFO' | 'BFO', price: number): ReturnType<LegBrokerOps['buyLimit']> {
    return OrderClient.getInstance().placeLimitBuyBare(userId, tradingSymbol, token, quantity, price, exchange, 'ant');
}

export const antLegOps: LegBrokerOps = { pickContract, buy, sell, cancel, buyLimit };
