import Log from '../../util/Log';
import ANT from '../../ant/ANT';
import AntContractMaster from '../../ant/AntContractMaster';
import { OrderSide, OrderPriceQuote, pickOrderPrice, priceLine } from '../../util/orderPriceCore';

// THE central order-price function. Every order intended as a market / LTP order (entry limits at the option LTP, marketable buys, index buys,
// hedge and leg buys, the target-hit sell) is priced here and nowhere else: BUY -> the REST best bid rounded down to the tick, SELL -> the REST
// best offer rounded up. The quote is fetched at order time (one call per order): ANT ScripDetails BRate/SRate for ant, kite, prism and paper
// (kite and prism price from ANT), Breeze getQuotes best_bid_price / best_offer_price for breeze. No refusal, guard or fallback: the order is
// always placed and may simply not fill; a quote call that throws takes the caller's existing error path.
// Not used by: stop / exit-monitor / EOD / POST /order/squareoff exits, lockProfits, max-profit latch sells, fixed-price orders (resting target
// sells from the fill, Expiry's re-buy at the original price, BulkPcr rebuyLimit, manual limit orders).
export interface OrderPriceRequest { side: OrderSide; tsym: string; token: string; exchange: 'NFO' | 'BFO'; broker: string }

export async function getOrderPrice(r: OrderPriceRequest): Promise<OrderPriceQuote> {
    let bid: number, ask: number, ltp: number;
    if (r.broker === 'breeze') {
        const { breezeBookQuote } = await import('./breezeExecutor'); // lazy: breezeExecutor itself prices its orders through this module
        ({ bid, ask, ltp } = await breezeBookQuote(r.tsym, r.token));
    } else {
        let token = r.token;
        // Prism orders may carry Prism's own instrument token, not ANT's: the contract is found by its trading symbol then.
        if (r.broker === 'prism') token = AntContractMaster.getInstance().findByAnyBrokerTradingSymbol(r.tsym, r.exchange)?.token ?? token;
        ({ bid, ask, ltp } = await ANT.getInstance().getLiveQuote(r.exchange, token));
    }
    const price = pickOrderPrice(r.side, bid, ask);
    const q: OrderPriceQuote = { price, bid, ask, ltp, spread: bid > 0 && ask > 0 ? Math.round((ask - bid) * 100) / 100 : null };
    Log.log(priceLine(r.side, r.tsym, r.broker, q));
    return q;
}

export async function orderPriceOf(r: OrderPriceRequest): Promise<number> {
    return (await getOrderPrice(r)).price;
}
