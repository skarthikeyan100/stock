import Log from '../../util/Log';
import { Trade } from '../../model/model';
import ANT from '../../ant/ANT';
import AntContractMaster from '../../ant/AntContractMaster';
import { exchangeForIndex } from '../../util/underlyings';
import bookkeeping from './bookkeeping';
import { DataLink } from '../../ipc/DataLink';
import { BrokerExecutor, OptionExchange, OrderAlreadyFilledError, ResolvedContract, emptyExitTrade } from './BrokerExecutor';
import type { CancelledListener } from './pendingOrderTracker';

// The `paper` broker: not a real broker. Everything lives in this process's memory - orders, fills, positions - and nothing is read from
// or written to Mongo (bookkeeping skips every Mongo write for broker 'paper'), so a restart forgets it all.
//   Limit buy:   accepted at once, filled in full at its limit price a moment later (after the caller has the order id: the strategy and
//                the reservation both need it before the fill arrives).
//   Limit sell:  rests in the in-memory book; filled in full at its limit price by the first option tick at or above it (or at once when
//                the last known price already is).
//   Market exit: filled at once at the last tick price (else ANT's quote) - squareOff, marketSell.
// Contracts are the ANT contract master's, so ticks and tokens are ANT's, like every other broker's.

interface PaperOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    token: string;
    quantity: number;
    price: number;
    exchange: OptionExchange;
    action: 'Buy' | 'Sell';
}

const orders = new Map<string, PaperOrder>();
const filledQty = new Map<string, number>(); // orderId -> quantity filled (so a late cancel reports OrderAlreadyFilledError)
const lastLtp = new Map<string, number>();    // ANT token -> last option tick price
const subscribed = new Set<string>();         // tokens the book holds a tick subscription for
const cancelledListeners: CancelledListener[] = [];
let seq = 0;

const nextId = (): string => `PAPER-${Date.now()}-${++seq}`;

// Test hook: forgets every order, fill memory and price.
export function resetPaperBook(): void {
    orders.clear(); filledQty.clear(); lastLtp.clear(); subscribed.clear(); seq = 0;
}

// The TrackerHandle shape (pendingTrackers.ts) over the in-memory book: nothing to load or poll.
export const PAPER_TRACKER = {
    find: (userId: string, tradingSymbol: string) => [...orders.values()].filter((o) => o.userId === userId && o.tradingSymbol === tradingSymbol)
        .map((o) => ({ orderId: o.orderId, action: o.action, quantity: o.quantity, exchange: o.exchange })),
    all: () => [...orders.values()].map((o) => ({ orderId: o.orderId, userId: o.userId, tradingSymbol: o.tradingSymbol, action: o.action, quantity: o.quantity, exchange: o.exchange })),
    load: async (): Promise<void> => undefined,
    poll: async (): Promise<void> => undefined,
    onCancelled: (listener: CancelledListener): void => { cancelledListeners.push(listener); },
};

function dataSubscribe(cmd: 'subscribe' | 'unsubscribe', token: string, exchange: OptionExchange): void {
    try { DataLink.getInstance().subscribe('paper', { cmd, token, source: 'ant', exchange }); } catch (e) { Log.log('[paper] tick subscription failed:', e); }
}
function holdTick(o: PaperOrder): void {
    if (subscribed.has(o.token)) return;
    subscribed.add(o.token);
    dataSubscribe('subscribe', o.token, o.exchange);
}
function releaseTick(o: PaperOrder): void {
    if (!subscribed.has(o.token)) return;
    if ([...orders.values()].some((x) => x.token === o.token)) return;
    subscribed.delete(o.token);
    dataSubscribe('unsubscribe', o.token, o.exchange);
}

function fillTrade(o: PaperOrder, price: number): Trade {
    const t = new Trade();
    t.tsym = o.tradingSymbol;
    t.token = o.token;
    t.quantity = o.quantity;
    t.price = price;
    t.lastTradePrice = price;
    t.action = o.action;
    t.status = 'COMPLETE';
    t.user = o.userId;
    t.broker = 'paper';
    t.brokerOrderId = o.orderId;
    return t;
}

// Books the whole order at `price` and removes it from the book. Idempotent: an order already gone is not filled twice.
async function fillOrder(orderId: string, price: number): Promise<void> {
    const o = orders.get(orderId);
    if (!o) return;
    orders.delete(orderId);
    filledQty.set(orderId, o.quantity);
    releaseTick(o);
    Log.log(`[paper] ${o.action} ${o.tradingSymbol} qty=${o.quantity} filled @ ${price} for ${o.userId}`);
    try {
        await bookkeeping.recordFill(fillTrade(o, price));
    } catch (e) {
        Log.log('[paper] ALERT: booking a paper fill failed:', o.orderId, o.tradingSymbol, e);
    }
}

// Quantity of a contract the user holds on paper, and how much of it already rests in sells.
function heldQty(userId: string, tsym: string): number {
    return bookkeeping.trades.filter((t) => t.broker === 'paper' && t.user === userId && t.tsym === tsym).reduce((n, t) => n + t.quantity, 0);
}
function restingSellQty(userId: string, tsym: string): number {
    return [...orders.values()].filter((o) => o.action === 'Sell' && o.userId === userId && o.tradingSymbol === tsym).reduce((n, o) => n + o.quantity, 0);
}

// The price a market-style paper order fills at: the last tick for the contract, else ANT's quote.
async function marketPrice(token: string, exchange: OptionExchange): Promise<number> {
    const seen = lastLtp.get(token);
    if (seen !== undefined && seen > 0) return seen;
    const q = Number(await ANT.getInstance().getScripQuote(exchange, token));
    if (!(q > 0)) throw new Error(`paper: no price for token ${token}`);
    return q;
}

// Called for every option tick the order process receives (orderProcess.onTick): records the price and fills resting sells it reaches.
export async function onPaperTick(quote: { token?: any; ltp?: number }): Promise<void> {
    const token = String(quote?.token ?? '');
    const ltp = Number(quote?.ltp);
    if (!token || !(ltp > 0)) return;
    lastLtp.set(token, ltp);
    for (const o of [...orders.values()]) {
        if (o.token === token && o.action === 'Sell' && ltp >= o.price) await fillOrder(o.orderId, o.price);
    }
}

async function placeLimit(action: 'Buy' | 'Sell', userId: string, tradingSymbol: string, token: string, quantity: number, price: number, exchange: OptionExchange): Promise<{ orderId: string; quantity: number }> {
    if (!(quantity > 0) || !(price > 0)) throw new Error(`paper: invalid ${action} order qty=${quantity} price=${price}`);
    const o: PaperOrder = { orderId: nextId(), userId, tradingSymbol, token, quantity, price, exchange, action };
    if (action === 'Sell') {
        // Never short: what is held minus what already rests in sells.
        const sellable = heldQty(userId, tradingSymbol) - restingSellQty(userId, tradingSymbol);
        if (sellable <= 0) throw new Error(`paper: nothing sellable for ${tradingSymbol} (${userId})`);
        o.quantity = Math.min(quantity, sellable);
    }
    orders.set(o.orderId, o);
    Log.log(`[paper] ${action} limit ${tradingSymbol} qty=${o.quantity} price=${price} for ${userId} (${o.orderId})`);
    if (action === 'Buy') {
        // Filled "immediately", but after the placing call has returned its order id.
        setTimeout(() => { void fillOrder(o.orderId, price); }, 0);
    } else {
        holdTick(o);
        const seen = lastLtp.get(token);
        if (seen !== undefined && seen >= price) setTimeout(() => { void fillOrder(o.orderId, price); }, 0);
    }
    return { orderId: o.orderId, quantity: o.quantity };
}

function cancelRestingSells(userId: string, tsym: string): void {
    for (const o of [...orders.values()]) {
        if (o.action === 'Sell' && o.userId === userId && o.tradingSymbol === tsym) { orders.delete(o.orderId); releaseTick(o); }
    }
}

async function marketSellOf(userId: string, tsym: string, token: string | undefined, quantity: number, exchange: OptionExchange): Promise<Trade> {
    cancelRestingSells(userId, tsym);
    const held = bookkeeping.trades.find((t) => t.broker === 'paper' && t.user === userId && t.tsym === tsym);
    const qty = Math.min(quantity, heldQty(userId, tsym));
    if (!held || !(qty > 0)) return emptyExitTrade(userId, tsym, 'paper');
    const tok = String(token ?? held.token);
    const price = await marketPrice(tok, exchange);
    const o: PaperOrder = { orderId: nextId(), userId, tradingSymbol: tsym, token: tok, quantity: qty, price, exchange, action: 'Sell' };
    filledQty.set(o.orderId, qty);
    const trade = fillTrade(o, price);
    Log.log(`[paper] Sell market ${tsym} qty=${qty} filled @ ${price} for ${userId}`);
    await bookkeeping.recordFill(trade);
    return trade;
}

async function marketBuyOf(userId: string, tsym: string, token: string, quantity: number, exchange: OptionExchange): Promise<Trade> {
    const price = await marketPrice(token, exchange);
    const o: PaperOrder = { orderId: nextId(), userId, tradingSymbol: tsym, token, quantity, price, exchange, action: 'Buy' };
    filledQty.set(o.orderId, quantity);
    const trade = fillTrade(o, price);
    Log.log(`[paper] Buy market ${tsym} qty=${quantity} filled @ ${price} for ${userId}`);
    await bookkeeping.recordFill(trade);
    return trade;
}

const unsupported = (what: string) => async (): Promise<never> => { throw new Error(`paper broker does not support ${what}`); };

export const PaperExecutor: BrokerExecutor = {
    brokerName: 'paper',

    buy: unsupported('manual buys (strategies only)'),
    enterShort: unsupported('short selling'),
    buyToClose: unsupported('short selling'),

    marketBuy: (userId, tsym, token, quantity, exchange) => marketBuyOf(userId, tsym, token, quantity, exchange),
    marketSell: (userId, tsym, token, quantity, exchange) => marketSellOf(userId, tsym, token, quantity, exchange),
    squareOff: (userId, tsym, quantity, exchange) => marketSellOf(userId, tsym, undefined, quantity, exchange as OptionExchange),

    placeLimitBuy: async (userId, tsym, token, quantity, price, exchange) => {
        const r = await placeLimit('Buy', userId, tsym, token, quantity, price, exchange);
        return { orderId: r.orderId };
    },
    squareOffLimit: (userId, tsym, instrumentId, quantity, exchange, limitPrice) =>
        placeLimit('Sell', userId, tsym, instrumentId, quantity, limitPrice, exchange as OptionExchange),

    cancelOrder: async (orderId) => {
        const o = orders.get(orderId);
        if (!o) {
            const done = filledQty.get(orderId);
            if (done !== undefined) throw new OrderAlreadyFilledError(orderId, done);
            throw new Error(`paper: unknown order ${orderId}`);
        }
        orders.delete(orderId);
        releaseTick(o);
        // The caller of an explicit cancel owns what happens next, like every other broker's tracker (no listener call).
        bookkeeping.releaseReservationForOrder(orderId);
    },

    getLiveQuantity: async (tsym) => bookkeeping.trades.filter((t) => t.broker === 'paper' && t.tsym === tsym).reduce((n, t) => n + t.quantity, 0),

    // ANT's contract: tsym is ANT's own trading symbol, token its common token.
    resolveContract: async (index, strike, right, skipNearestExpiryDay, expiryOffset = 0): Promise<ResolvedContract> => {
        const r = AntContractMaster.getInstance().findNearestExpiryOption({ symbol: index, exch: exchangeForIndex(index), strike, optionType: right, expiryOffset, skipNearestExpiryDay });
        return { tsym: r.tradingSymbol, token: r.token, exchange: exchangeForIndex(index) as 'NFO' | 'BFO' };
    },
    getContractByPriceRange: unsupported('price-range contract lookup'),

    findPendingOrders: (userId, tsym) => PAPER_TRACKER.find(userId, tsym),
};
