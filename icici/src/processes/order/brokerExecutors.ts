// Assembles the broker-specific modules (kiteExecutor.ts, antExecutor.ts, prismExecutor.ts, breezeExecutor.ts) behind the
// common BrokerExecutor interface - see BrokerExecutor.ts for what is common vs. deliberately left broker-specific. Thin
// wrapping only: no behaviour change to the functions these call into.

import { Trade } from '../../model/model';
import { BrokerExecutor, BuyRequest, OptionIndex, OptionRight, ResolvedContract } from './BrokerExecutor';
import * as kiteExecutor from './kiteExecutor';
import * as antExecutor from './antExecutor';
import * as prismExecutor from './prismExecutor';
import * as breezeExecutor from './breezeExecutor';
import bookkeeping from './bookkeeping';
import { TRACKERS } from './pendingTrackers';
import { normalizeBrokerName } from '../../util/brokerName';
import { exchangeForIndex } from '../../util/underlyings';
import Kite from '../../kite/Kite';
import KiteContractMaster from '../../kite/KiteContractMaster';
import AntContractMaster from '../../ant/AntContractMaster';
import PrismContractMaster from '../../prism/PrismContractMaster';
import BreezeContractMaster from '../../breeze/BreezeContractMaster';

type Exch = 'NFO' | 'BFO';

const unsupported = (broker: string, op: string) => (): never => {
    throw new Error(`${op}: not supported for ${broker}`);
};

// ANT's common token for a strike (every broker's tick routing and Trade.token key off it, never the broker's own instrument id).
function antContractFor(index: OptionIndex, strike: number, right: OptionRight) {
    return AntContractMaster.getInstance().findNearestExpiryOption({ symbol: index, exch: exchangeForIndex(index), strike, optionType: right, expiryOffset: 0 });
}
const antTokenFor = (index: OptionIndex, strike: number, right: OptionRight): string => antContractFor(index, strike, right).token;

export const KiteExecutor: BrokerExecutor = {
    brokerName: 'kite',
    capabilities: { placeLimitBuy: true, getContractByPriceRange: true },

    buy: (request: BuyRequest): Promise<Trade> => kiteExecutor.buyResolvedOnKite(request),

    // Kite never trades NSE cash through this path (Exchange was widened to include 'NSE' only for Breeze) - the cast is safe,
    // this dispatch only ever reaches here for Kite-broker users.
    squareOff: (userId, tradingSymbol, quantity, exchange) =>
        kiteExecutor.squareOffOnKite(userId, tradingSymbol, quantity, exchange as Exch),

    squareOffLimit: (userId, tradingSymbol, instrumentId, quantity, exchange, limitPrice) =>
        kiteExecutor.placeLimitSellBareOnKite(userId, tradingSymbol, instrumentId, quantity, limitPrice, exchange as Exch),

    cancelOrder: (orderId) => kiteExecutor.cancelOrderOnKite(orderId),

    enterShort: kiteExecutor.enterShortOnKite,
    buyToClose: kiteExecutor.buyToCloseOnKite,
    marketBuy: kiteExecutor.marketBuyBareOnKite,
    marketSell: kiteExecutor.marketSellBareOnKite,
    placeLimitBuy: kiteExecutor.placeLimitBuyBareOnKite,
    getLiveQuantity: (tradingSymbol) => Kite.getInstance().getLiveNetQuantity(tradingSymbol),
    // trade.token/tick subscriptions must always carry the ANT common token, never Kite's own instrument_token - ANT is the sole
    // live-tick source and the only thing exitMonitor/tokenRouter's subscriptions understand (see AntContractMaster's comment on
    // this invariant). Kite's instrumentToken is discarded here.
    resolveContract: async (index, strike, right): Promise<ResolvedContract> => {
        const r = await KiteContractMaster.getInstance().findNearestExpiryOption(strike, right, index, 0);
        return { tsym: r.tradingSymbol, token: antTokenFor(index, strike, right), exchange: r.exchange };
    },
    getContractByPriceRange: kiteExecutor.getContractByPriceRangeOnKite,
    findPendingOrders: (userId, tradingSymbol) => TRACKERS.kite.find(userId, tradingSymbol),
};

export const AntExecutor: BrokerExecutor = {
    brokerName: 'ant',
    // placeLimitBuy is off on purpose: the generic limit-buy ops refuse ANT (its limit buy has its own antPlaceLimitBuyBare request).
    capabilities: { placeLimitBuy: false, getContractByPriceRange: false },

    buy: (request: BuyRequest): Promise<Trade> =>
        antExecutor.enterPosition(
            request.userId, request.tradingSymbol, request.instrumentId, request.quantity, request.exchange as Exch,
            request.targetPoints ?? 0, request.stopLossPoints ?? 0,
        ),

    // Same 'NSE'-is-Breeze-only reasoning as KiteExecutor above.
    squareOff: (userId, tradingSymbol, quantity, exchange) =>
        antExecutor.squareOffOnAnt(userId, tradingSymbol, quantity, exchange as Exch),

    squareOffLimit: (userId, tradingSymbol, instrumentId, quantity, exchange, limitPrice) =>
        antExecutor.placeLimitSellBareOnAnt(userId, tradingSymbol, instrumentId, quantity, limitPrice, exchange as Exch),

    cancelOrder: (orderId) => antExecutor.cancelOrderOnAnt(orderId),

    enterShort: antExecutor.enterShortPosition,
    buyToClose: antExecutor.buyToClosePosition,
    marketBuy: (userId, tradingSymbol, instrumentToken, quantity, exchange) =>
        antExecutor.enterPosition(userId, tradingSymbol, instrumentToken, quantity, exchange, 0, 0, 'target-only'),
    marketSell: (userId, tradingSymbol, _instrumentToken, quantity, exchange) => antExecutor.squareOffOnAnt(userId, tradingSymbol, quantity, exchange),
    placeLimitBuy: unsupported('ant', 'placeLimitBuy'),
    getLiveQuantity: antExecutor.getLiveNetQuantity,
    resolveContract: async (index, strike, right): Promise<ResolvedContract> => {
        const r = antContractFor(index, strike, right);
        return { tsym: r.tradingSymbol, token: r.token, exchange: r.exch as Exch };
    },
    getContractByPriceRange: unsupported('ant', 'getContractByPriceRange'),
    findPendingOrders: (userId, tradingSymbol) => TRACKERS.ant.find(userId, tradingSymbol),
};

export const PrismExecutor: BrokerExecutor = {
    brokerName: 'prism',
    capabilities: { placeLimitBuy: false, getContractByPriceRange: false },

    buy: (request: BuyRequest): Promise<Trade> => prismExecutor.buyOnPrism(request),

    squareOff: (userId, tradingSymbol, quantity, _exchange) =>
        prismExecutor.squareOffOnPrism(userId, tradingSymbol, quantity),

    squareOffLimit: (userId, tradingSymbol, instrumentId, quantity, exchange, limitPrice) =>
        prismExecutor.placeLimitSellBareOnPrism(userId, tradingSymbol, instrumentId, quantity, limitPrice, exchange as Exch),

    cancelOrder: (orderId) => prismExecutor.cancelOrderOnPrism(orderId),

    enterShort: prismExecutor.enterShortOnPrism,
    buyToClose: prismExecutor.buyToClosePrism,
    marketBuy: (userId, tradingSymbol, _instrumentToken, quantity) => prismExecutor.buyContract(userId, tradingSymbol, quantity),
    marketSell: (userId, tradingSymbol, _instrumentToken, quantity) => prismExecutor.sellContract(userId, tradingSymbol, quantity),
    placeLimitBuy: unsupported('prism', 'placeLimitBuy'),
    getLiveQuantity: async (tradingSymbol) => Number((await prismExecutor.getPositionsOnPrism()).find((p) => p.tradingSymbol === tradingSymbol)?.quantity ?? 0),
    // Prism's own contract master (NFO_symbols.txt) carries no exchange field and uses the Shoonya/Prism token scheme, which is
    // NOT cross-referenced with ANT's - so ANT's token is resolved separately (every live tick flows through ANT).
    resolveContract: async (index, strike, right): Promise<ResolvedContract> => {
        const r = PrismContractMaster.getInstance().findNearestExpiryOption(index, strike, right, 0);
        return { tsym: r.tradingSymbol, token: antTokenFor(index, strike, right), exchange: exchangeForIndex(index) };
    },
    getContractByPriceRange: unsupported('prism', 'getContractByPriceRange'),
    findPendingOrders: (userId, tradingSymbol) => TRACKERS.prism.find(userId, tradingSymbol),
};

export const BreezeExecutor: BrokerExecutor = {
    brokerName: 'breeze',
    capabilities: { placeLimitBuy: true, getContractByPriceRange: true },

    buy: breezeExecutor.buyResolvedOnBreeze,

    squareOff: (userId, tradingSymbol, quantity, _exchange) =>
        breezeExecutor.squareOffOnBreeze(userId, tradingSymbol, quantity),

    squareOffLimit: (userId, tradingSymbol, instrumentId, quantity, exchange, limitPrice) =>
        breezeExecutor.placeLimitSellBareOnBreeze(userId, tradingSymbol, instrumentId, quantity, limitPrice, exchange as Exch),

    cancelOrder: (orderId, exchange) => breezeExecutor.cancelOrderOnBreeze(orderId, exchange),

    enterShort: breezeExecutor.enterShortOnBreeze,
    buyToClose: breezeExecutor.buyToCloseOnBreeze,
    marketBuy: breezeExecutor.marketBuyBareOnBreeze,
    marketSell: breezeExecutor.marketSellBareOnBreeze,
    placeLimitBuy: breezeExecutor.placeLimitBuyBareOnBreeze,
    getLiveQuantity: breezeExecutor.getLiveNetQuantity,
    resolveContract: async (index, strike, right): Promise<ResolvedContract> => {
        const r = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, right, index);
        return { tsym: breezeExecutor.tsymFor(r), token: antTokenFor(index, strike, right), exchange: exchangeForIndex(index) };
    },
    getContractByPriceRange: breezeExecutor.getContractByPriceRangeOnBreeze,
    findPendingOrders: (userId, tradingSymbol) => TRACKERS.breeze.find(userId, tradingSymbol),
};

const EXECUTORS = { kite: KiteExecutor, ant: AntExecutor, breeze: BreezeExecutor, prism: PrismExecutor } as const;

// The executor for an explicit broker name (aliases accepted); throws on an unknown one.
export function getExecutorByBroker(name: unknown, op?: string): BrokerExecutor {
    const broker = normalizeBrokerName(name);
    if (!Object.prototype.hasOwnProperty.call(EXECUTORS, broker)) throw new Error(`${op ?? 'getExecutorByBroker'}: unsupported broker '${broker}'`);
    return EXECUTORS[broker as keyof typeof EXECUTORS];
}

// Resolves a user's configured broker to its BrokerExecutor - replaces the
// repeated `bookkeeping.getUserBroker(userId) === 'ant' ? antExecutor.X(...)
// : kiteExecutor.X(...)` branch that used to live at every orderProcess.ts
// IPC handler. Per-userId resolution (bookkeeping.getUserBroker) is still
// 'kite' | 'ant' | 'breeze' only - Prism has its own separate
// 'buyContract'/'sellContract' IPC actions and isn't a per-user broker
// choice. `brokerOverride` widens to also accept 'prism', letting a single
// call bypass per-userId resolution entirely - needed by BulkPcrStrategy's
// multi-broker support, where one strategy identity places independent
// full-quantity orders on several brokers at once, so no single per-userId
// broker can describe "which broker this specific call is for." Every other
// caller omits it and gets today's per-userId behavior unchanged.
export function getBrokerExecutor(userId: string, brokerOverride?: string | null): BrokerExecutor {
    // An unknown name throws: a silent fallback to Kite would send another broker's order to the wrong account.
    // An absent, empty or blank override (a trade row with no broker) means "use the user's broker"; exit paths rely on it. Anything
    // else that is not a known broker name (a number, an object, a typo) throws instead of falling back to another account.
    const useUserBroker = brokerOverride === undefined || brokerOverride === null || (typeof brokerOverride === 'string' && normalizeBrokerName(brokerOverride) === '');
    return getExecutorByBroker(useUserBroker ? bookkeeping.getUserBroker(userId) : brokerOverride, 'getBrokerExecutor');
}
