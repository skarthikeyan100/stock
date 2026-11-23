// The one pure rule behind every order that is INTENDED as a market / LTP order: a BUY is priced at the best bid, a SELL at the best offer
// (ask). Both are passive prices - a buy rests below the market, a sell above it - so the order may simply not fill. Rounded to the tick in
// the direction that never crosses the quote: a buy DOWN (never above the bid), a sell UP (never below the ask). No improvement, no offset,
// no guard and no fallback: the side's quote is the price. See processes/order/orderPrice.ts for the fetch.
import { NFO_TICK_SIZE } from './tick';

export type OrderSide = 'BUY' | 'SELL';

export function roundDownToTick(price: number, tick: number = NFO_TICK_SIZE): number {
    return Math.round(Math.floor(price / tick + 1e-6) * tick * 100) / 100;
}

export function roundUpToTick(price: number, tick: number = NFO_TICK_SIZE): number {
    return Math.round(Math.ceil(price / tick - 1e-6) * tick * 100) / 100;
}

export function pickOrderPrice(side: OrderSide, bid: number, ask: number, tick: number = NFO_TICK_SIZE): number {
    return side === 'BUY' ? roundDownToTick(bid, tick) : roundUpToTick(ask, tick);
}

export interface OrderPriceQuote { price: number; bid: number; ask: number; ltp: number; spread: number | null }

const f = (n: number | null | undefined): string => (n !== null && n !== undefined && Number.isFinite(n) && n > 0 ? String(n) : 'n/a');

export function priceLine(side: OrderSide, tsym: string, broker: string, q: OrderPriceQuote): string {
    return `[order] price pick: ${side} ${tsym} broker=${broker} bid=${f(q.bid)} ask=${f(q.ask)} ltp=${f(q.ltp)} spread=${q.spread === null ? 'n/a' : q.spread} -> ${q.price}`;
}
