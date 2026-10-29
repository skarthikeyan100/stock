import Log from '../util/Log';
import OrderClient from '../processes/strategies/OrderClient';
import { Trade } from '../model/model';
import { BrokerName, normalizeBrokerName } from '../util/brokerName';
import { HEDGE_UNCONFIRMED_TAG } from '../ipc/orderProtocol';

// Thrown by a sell that confirmed only part of the quantity (the rest is unconfirmed or still resting). LegManager shrinks the leg by
// `soldQty` before any retry so the retry sells what is left, not the original size (review R5-5).
export class PartialSellError extends Error {
    constructor(message: string, public readonly soldQty: number) {
        super(message);
        this.name = 'PartialSellError';
    }
}

export interface LegContract {
    tradingSymbol: string;
    token: string; // broker/ANT token as a string (the tick-routing key)
    exchange: 'NFO' | 'BFO';
    strike: number;
    premium: number;
}

export interface LegBrokerOps {
    pickContract(userId: string, underlyingLtp: number, optionType: 'CE' | 'PE', minPremium: number, excludeStrikes: number[]): Promise<LegContract>;
    buy(userId: string, tradingSymbol: string, token: string, quantity: number, exchange: 'NFO' | 'BFO', premiumHint: number): Promise<Trade>;
    sell(userId: string, tradingSymbol: string, token: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<unknown>;
    cancel(userId: string, orderId: string, exchange?: 'NFO' | 'BFO'): Promise<void>;
    buyLimit(userId: string, tradingSymbol: string, token: string, quantity: number, exchange: 'NFO' | 'BFO', price: number): Promise<{ orderId: string }>;
}

// Sells `quantity` through the order process's chunked square-off (one order above the exchange freeze quantity is rejected outright,
// leaving the leg open and LegManager retrying the same oversized sell forever). A run that stops early - an exit placed but its fill
// unconfirmed, or a later chunk failing - surfaces as PartialSellError(soldQty) so LegManager shrinks the leg before retrying (R5-5/R5-6).
// `broker` omitted = the user's configured broker.
export async function chunkedLegSell(userId: string, tradingSymbol: string, quantity: number, broker?: BrokerName) {
    let res: any;
    try {
        res = await OrderClient.getInstance().chunkedSquareOff(userId, { tradingSymbol, quantity, ...(broker ? { broker } : {}) });
    } catch (e: any) {
        // The chunked run's error message carries what earlier chunks already sold ("... failed after selling X/Y ..."); the IPC drops its fields.
        const sold = Number(/failed after selling (\d+)\//.exec(String(e?.message))?.[1] ?? 0);
        if (sold > 0) throw new PartialSellError(e.message, sold);
        throw e;
    }
    if (Number(res?.quantity ?? quantity) < quantity) {
        throw new PartialSellError(`sell of ${tradingSymbol}: only ${res.quantity}/${quantity} confirmed sold (rest unconfirmed, still being re-priced)`, Math.max(0, Number(res?.quantity) || 0));
    }
    return res;
}

// LegManager's order routing for one broker, through the generic 'Bare' IPC family with an explicit `broker` on every call, so a
// strategy never names a broker's own API (the ANT-only ops with their option-chain strike pick are gone: the order side now resolves
// the contract for every broker, see getContractByPriceRange in brokerExecutors.ts). `brokerOf` is read at call time: it is the
// strategy's own `broker:` config key, or undefined to route by the user's configured broker as before.
// placeLimitBuyBare's own parameter order is (userId, tsym, token, quantity, price, exchange) - price BEFORE exchange, unlike every
// other method here - so the forwarding call below deliberately does not just spread args through in LegBrokerOps.buyLimit's order.
export function brokerLegOps(brokerOf: () => unknown = () => undefined): LegBrokerOps {
    const broker = (): BrokerName | undefined => (normalizeBrokerName(brokerOf()) || undefined) as BrokerName | undefined;
    return {
        async pickContract(userId, underlyingLtp, optionType, minPremium, excludeStrikes) {
            const c = await OrderClient.getInstance().getContractByPriceRangeBare(userId, underlyingLtp, optionType, minPremium, 'NIFTY', excludeStrikes, broker());
            return { tradingSymbol: c.tradingSymbol, token: String(c.antToken), exchange: c.exchange, strike: c.strike, premium: c.premium };
        },
        async buy(userId, tradingSymbol, token, quantity, exchange, premiumHint) {
            try {
                return await OrderClient.getInstance().buyContractBare(userId, tradingSymbol, token, quantity, exchange, premiumHint, broker());
            } catch (e: any) {
                const message = typeof e?.message === 'string' ? e.message : String(e);
                // "fill status unresolved" is resolveUnconfirmedAntBuy's actual thrown message for every genuinely ambiguous outcome
                // (a timed-out waitForFill is caught inside enterPosition and falls through to a REST fallback first). The order's true
                // outcome could not be confirmed, so it may still be live: never safe to retry (double-buy risk) or to swallow (an
                // unmonitored live position). The distinguishing prefix lets LegManager (deps.onSpawnBuyError) flag the tree for manual
                // review instead of treating it as an ordinary, retryable spawn failure. Other brokers' ambiguous fills reach the same
                // handler already tagged by the order process (ORDER_MAY_BE_LIVE_TAG).
                if (message.includes('fill status unresolved')) {
                    Log.log(`[LegBrokerOps] ALERT: buy for ${tradingSymbol} qty=${quantity} unconfirmed - manual review needed (order may be live at the broker): ${message}`);
                    throw new Error(`${HEDGE_UNCONFIRMED_TAG} ${message}`);
                }
                throw e;
            }
        },
        sell: (userId, tradingSymbol, _token, quantity, _exchange) => chunkedLegSell(userId, tradingSymbol, quantity, broker()),
        cancel: (userId, orderId, exchange) => OrderClient.getInstance().cancelOrderBare(userId, orderId, exchange, broker()),
        buyLimit: (userId, tradingSymbol, token, quantity, exchange, price) =>
            OrderClient.getInstance().placeLimitBuyBare(userId, tradingSymbol, token, quantity, price, exchange, broker()),
    };
}

// Routes by the user's configured broker (no explicit `broker:` on the strategy).
export const defaultLegOps: LegBrokerOps = brokerLegOps();

// Wraps `base` so buy/sell/cancel/buyLimit only log and return a synthetic
// result - no broker order is ever placed. pickContract stays real (read-only,
// needed for dry-run logging of a sensible strike/premium).
export function dryRunOps(base: LegBrokerOps): LegBrokerOps {
    return {
        pickContract: base.pickContract,
        async buy(userId, tradingSymbol, token, quantity, exchange, premiumHint) {
            Log.log(`[DRYRUN] would buy ${tradingSymbol} qty=${quantity} @ ~${premiumHint} (${exchange})`);
            const trade = new Trade();
            trade.tsym = tradingSymbol;
            trade.token = token;
            trade.price = premiumHint;
            trade.lastTradePrice = premiumHint;
            trade.quantity = quantity;
            trade.action = 'Buy';
            trade.status = 'COMPLETE';
            trade.user = userId;
            return trade;
        },
        async sell(userId, tradingSymbol, token, quantity, exchange) {
            Log.log(`[DRYRUN] would sell ${tradingSymbol} qty=${quantity} (${exchange})`);
            return undefined;
        },
        async cancel(userId, orderId) {
            Log.log(`[DRYRUN] would cancel order ${orderId}`);
            return undefined;
        },
        async buyLimit(userId, tradingSymbol, token, quantity, exchange, price) {
            Log.log(`[DRYRUN] would place limit buy ${tradingSymbol} qty=${quantity} @ ${price} (${exchange})`);
            return { orderId: 'DRYRUN' };
        },
    };
}
