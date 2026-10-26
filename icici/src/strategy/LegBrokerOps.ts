import Log from '../util/Log';
import OrderClient from '../processes/strategies/OrderClient';
import { Trade } from '../model/model';

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
    cancel(userId: string, orderId: string): Promise<void>;
    buyLimit(userId: string, tradingSymbol: string, token: string, quantity: number, exchange: 'NFO' | 'BFO', price: number): Promise<{ orderId: string }>;
}

// Default = exactly today's Kite/Breeze behaviour (ContinuousStrategy uses this,
// unchanged). placeLimitBuyBare's own parameter order is (userId, tsym, token,
// quantity, price, exchange) - price BEFORE exchange, unlike every other method
// here - so the forwarding call below deliberately does not just spread args
// through in LegBrokerOps.buyLimit's own (..., exchange, price) order.
export const defaultLegOps: LegBrokerOps = {
    async pickContract(userId, underlyingLtp, optionType, minPremium, excludeStrikes) {
        const c = await OrderClient.getInstance().getContractByPriceRangeBare(userId, underlyingLtp, optionType, minPremium, 'NIFTY', excludeStrikes);
        return { tradingSymbol: c.tradingSymbol, token: String(c.antToken), exchange: c.exchange, strike: c.strike, premium: c.premium };
    },
    buy: (userId, tradingSymbol, token, quantity, exchange, premiumHint) =>
        OrderClient.getInstance().buyContractBare(userId, tradingSymbol, token, quantity, exchange, premiumHint),
    sell: (userId, tradingSymbol, token, quantity, exchange) =>
        OrderClient.getInstance().sellContractBare(userId, tradingSymbol, token, quantity, exchange),
    cancel: (userId, orderId) => OrderClient.getInstance().cancelOrderBare(userId, orderId),
    buyLimit: (userId, tradingSymbol, token, quantity, exchange, price) =>
        OrderClient.getInstance().placeLimitBuyBare(userId, tradingSymbol, token, quantity, price, exchange),
};

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
