// Assembles the three broker-specific modules (zerodhaExecutor.ts,
// antExecutor.ts, prismExecutor.ts) behind the common BrokerExecutor
// interface - see BrokerExecutor.ts for what's common vs. deliberately left
// broker-specific. Thin wrapping only: no behavior change to any of the
// already-working functions these call into.

import { Trade } from '../../model/model';
import { BrokerExecutor, BuyRequest, BrokerPosition } from './BrokerExecutor';
import Zerodha from '../../zerodha/Zerodha';
import ANT from '../../ant/ANT';
import * as zerodhaExecutor from './zerodhaExecutor';
import * as antExecutor from './antExecutor';
import * as prismExecutor from './prismExecutor';
import { BreezeExecutor } from './breezeExecutor';
import bookkeeping from './bookkeeping';

export const ZerodhaExecutor: BrokerExecutor = {
    brokerName: 'zerodha',

    hasValidSession: () => Zerodha.getInstance().hasValidSession(),

    buy: (request: BuyRequest): Promise<Trade> => zerodhaExecutor.buyResolvedOnZerodha(request),

    // Zerodha never trades NSE cash through this path (Exchange was widened
    // to include 'NSE' only for Breeze) - cast is safe, this dispatch only
    // ever reaches here for Zerodha-broker users.
    squareOff: (userId, tradingSymbol, quantity, exchange) =>
        zerodhaExecutor.squareOffOnZerodha(userId, tradingSymbol, quantity, exchange as 'NFO' | 'BFO'),

    squareOffLimit: (userId, tradingSymbol, instrumentId, quantity, exchange, limitPrice) =>
        zerodhaExecutor.placeLimitSellBareOnZerodha(userId, tradingSymbol, instrumentId, quantity, limitPrice, exchange as 'NFO' | 'BFO'),

    cancelOrder: (orderId) => zerodhaExecutor.cancelOrderOnZerodha(orderId),

    getFillPrice: (orderId) => Zerodha.getInstance().getFillPrice(orderId),

    getPositions: async (): Promise<BrokerPosition[]> => {
        const positions = await Zerodha.getInstance().getPositions();
        const net: any[] = positions?.net ?? positions ?? [];
        return (Array.isArray(net) ? net : []).map((p: any) => ({
            tradingSymbol: p.tradingsymbol,
            instrumentId: String(p.instrument_token),
            quantity: Number(p.quantity ?? 0),
            avgPrice: Number(p.average_price ?? 0),
            exchange: p.exchange ?? 'NFO',
        }));
    },

    getTrades: () => Zerodha.getInstance().getTrades(),
};

export const AntExecutor: BrokerExecutor = {
    brokerName: 'ant',

    hasValidSession: () => ANT.getInstance().hasValidSession(),

    buy: (request: BuyRequest): Promise<Trade> =>
        antExecutor.enterPosition(
            request.userId, request.tradingSymbol, request.instrumentId, request.quantity, request.exchange as 'NFO' | 'BFO',
            request.targetPoints ?? 0, request.stopLossPoints ?? 0,
        ),

    // Same 'NSE'-is-Breeze-only reasoning as ZerodhaExecutor above.
    squareOff: (userId, tradingSymbol, quantity, exchange) =>
        antExecutor.squareOffOnAnt(userId, tradingSymbol, quantity, exchange as 'NFO' | 'BFO'),

    squareOffLimit: (userId, tradingSymbol, instrumentId, quantity, exchange, limitPrice) =>
        antExecutor.placeLimitSellBareOnAnt(userId, tradingSymbol, instrumentId, quantity, limitPrice, exchange as 'NFO' | 'BFO'),

    cancelOrder: (orderId) => antExecutor.cancelOrderOnAnt(orderId),

    getFillPrice: (orderId) => ANT.getInstance().getFillPrice(orderId),

    getPositions: async (): Promise<BrokerPosition[]> => {
        const positions = await ANT.getInstance().getPositions();
        return (Array.isArray(positions) ? positions : []).map((p: any) => ({
            tradingSymbol: p.tradingSymbol ?? p.tsym,
            instrumentId: String(p.token ?? p.instrumentId ?? ''),
            quantity: Number(p.netQty ?? p.quantity ?? 0),
            avgPrice: Number(p.netAvgPrice ?? p.avgPrice ?? 0),
            exchange: p.exchange ?? p.exch ?? 'NFO',
        }));
    },

    getTrades: () => ANT.getInstance().getTrades(),
};

export const PrismExecutor: BrokerExecutor = {
    brokerName: 'prism',

    hasValidSession: () => prismExecutor.hasValidSessionOnPrism(),

    buy: (request: BuyRequest): Promise<Trade> => prismExecutor.buyOnPrism(request),

    squareOff: (userId, tradingSymbol, quantity, _exchange) =>
        prismExecutor.squareOffOnPrism(userId, tradingSymbol, quantity),

    squareOffLimit: (userId, tradingSymbol, instrumentId, quantity, exchange, limitPrice) =>
        prismExecutor.placeLimitSellBareOnPrism(userId, tradingSymbol, instrumentId, quantity, limitPrice, exchange as 'NFO' | 'BFO'),

    cancelOrder: (orderId) => prismExecutor.cancelOrderOnPrism(orderId),

    getFillPrice: (orderId) => prismExecutor.getFillPriceOnPrism(orderId),

    getPositions: () => prismExecutor.getPositionsOnPrism(),

    getTrades: () => prismExecutor.getTradesOnPrism(),
};

// Resolves a user's configured broker to its BrokerExecutor - replaces the
// repeated `bookkeeping.getUserBroker(userId) === 'ant' ? antExecutor.X(...)
// : zerodhaExecutor.X(...)` branch that used to live at every orderProcess.ts
// IPC handler. Per-userId resolution (bookkeeping.getUserBroker) is still
// 'zerodha' | 'ant' | 'breeze' only - Prism has its own separate
// 'buyContract'/'sellContract' IPC actions and isn't a per-user broker
// choice. `brokerOverride` widens to also accept 'prism', letting a single
// call bypass per-userId resolution entirely - needed by BulkPcrStrategy's
// multi-broker support, where one strategy identity places independent
// full-quantity orders on several brokers at once, so no single per-userId
// broker can describe "which broker this specific call is for." Every other
// caller omits it and gets today's per-userId behavior unchanged.
export function getBrokerExecutor(userId: string, brokerOverride?: 'zerodha' | 'ant' | 'breeze' | 'prism'): BrokerExecutor {
    const broker = brokerOverride ?? bookkeeping.getUserBroker(userId);
    if (broker === 'ant') return AntExecutor;
    if (broker === 'breeze') return BreezeExecutor;
    if (broker === 'prism') return PrismExecutor;
    return ZerodhaExecutor;
}
