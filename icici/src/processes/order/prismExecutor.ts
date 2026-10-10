import Log from '../../util/Log';
import Prism from '../../prism';
import indexMap from '../../nse_index';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { BuyRequest, BrokerPosition } from './BrokerExecutor';
import { trackPendingPrismLimitOrder } from './pendingPrismLimitOrders';

// Prism/Shoonya's contract-by-price-range order path - the secondary/legacy
// broker path (Zerodha is primary, see zerodhaExecutor.ts). `Prism.getInstance()`
// itself is reused as-is (its internal Monitor coupling was removed in favor of
// bookkeeping.ts - see src/prism.ts); this module just exposes the read-only
// lookups and order placement over IPC and folds fills into the same
// bookkeeping/fill-notification path buyIndexOnZerodha uses.

export async function getContractByPriceRange(right: string): Promise<string | null> {
    return Prism.getInstance().getContractByPriceRange(right);
}

export async function calculateRight(ltp?: number): Promise<string> {
    return Prism.getInstance().calculateRight(ltp);
}

export async function getToken(contract: string): Promise<string> {
    return Prism.getInstance().getToken(contract);
}

export async function getNiftyQuote(): Promise<any> {
    return Prism.getInstance().getNiftyQuote();
}

export async function getIndexQuote(index: 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY'): Promise<any> {
    if (index === 'BANKNIFTY') return Prism.getInstance().getBankNiftyQuote();
    if (index === 'FINNIFTY') return Prism.getInstance().getFinNiftyQuote();
    return Prism.getInstance().getNiftyQuote();
}

export async function getStockQuote(symbol: string): Promise<any> {
    return Prism.getInstance().getStockQuote(symbol);
}

// GET /connect: re-establish Prism/Shoonya's websocket (order-fill
// notifications only - quotes come from `data`/ANT, not this).
export async function connectPrism(): Promise<void> {
    await Prism.getInstance().connect();
}

export async function getOptionQuote(token: string): Promise<any> {
    return Prism.getInstance().getOptionQuote(token);
}

export async function getStockOptionQuote(contract: string): Promise<any> {
    return Prism.getInstance().getStockOptionQuote(contract);
}

export async function buyContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
    Log.log(`[order] Buying (Prism) ${contract} qty=${quantity} for ${userId}`);
    const response = await Prism.getInstance().buyContract(contract, quantity, price);
    if (!response) throw new Error(`buyContract failed for ${contract}`);

    const trade = new Trade();
    trade.tsym = response.contract;
    trade.token = response.token;
    trade.quantity = response.qty;
    trade.price = response.price;
    trade.lastTradePrice = response.price;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'prism';

    await bookkeeping.recordFill(trade);
    return response;
}

// GET /search: debug token finder by depth (distinct from getContractByPriceRange,
// which searches by a price *range* - this is index+depth+right -> token).
export async function findToken(index: string, depth: number, right: string): Promise<string> {
    const nseIndex = indexMap.get(index);
    return nseIndex.findToken(index, depth, right);
}

export async function getOrders(): Promise<any> {
    return Prism.getInstance().getOrders();
}

// GET /refreshtrades: pull live positions from the broker and replace
// bookkeeping.trades wholesale (Prism.refreshTradeList already calls
// bookkeeping.refreshTrades internally - see src/prism.ts's Monitor->bookkeeping
// redirect - this is just the IPC-reachable entry point for it).
export async function refreshTradeList(): Promise<any> {
    return Prism.getInstance().refreshTradeList();
}

export async function sellContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
    Log.log(`[order] Selling (Prism) ${contract} qty=${quantity} for ${userId}`);
    // Resolve price up front (rather than relying on sellContract's own
    // fallback, which doesn't return it) so bookkeeping's P&L calc has a real
    // sell price to work with.
    const resolvedPrice = price ?? (await Prism.getInstance().getStockOptionQuote(contract)).ltp;
    const { filledQty } = await Prism.getInstance().sellContract(contract, quantity, resolvedPrice, userId);

    const trade = new Trade();
    trade.tsym = contract;
    trade.token = await Prism.getInstance().getToken(contract);
    trade.quantity = filledQty;
    trade.price = resolvedPrice;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'prism';

    await bookkeeping.recordFill(trade);
    return trade;
}

// --- BrokerExecutor surface - see BrokerExecutor.ts ---
// Cover order is real new capability (see prism.ts's placeCoverOrder/
// exitCoverOrder/getOrderFillPrice for the Shoonya/Noren mechanics);
// everything else here wraps the already-working functions above.

// Prism's buyContract()/sellContract() helpers above place a LIMIT order at
// the exact quoted LTP (no marketable buffer, unlike ANT's ltp*1.01) and then
// unconditionally treat it as filled after a flat 2s delay - no broker-side
// fill check at all (see prism.ts's _placeOrderWithForce, which always
// returns status ORDERED regardless of what actually happened at the
// broker). That's a real risk for BulkPcrStrategy's auto-arm entry
// specifically: it immediately rests a real SELL LIMIT for whatever
// buyOnPrism reports as "held" (placeExitSell), so an unverified "fill" that
// never actually happened would place a genuinely naked sell the moment that
// exit crosses the market, with nothing anywhere noticing. Polls the actual
// order status (same getOrderStatus the sell-leg pending tracker already
// uses) before trusting a fill; cancels and fails closed (throws, so
// enterOnBroker marks that broker's position phase='error' instead of
// proceeding to place an exit sell) if it never confirms.
// Fewer, more widely-spaced polls than a naive 1-2s loop would use - each
// poll is its own get_orderbook call (getOrderStatus has no shared-snapshot
// param here, unlike pollPendingPrismLimitOrders' batched poll), running
// concurrently with that same 15s-interval poller - this project has already
// hit a live broker-API rate limit from exactly this kind of redundant
// back-to-back call pattern (see chunkedOrder.ts/pendingPrismLimitOrders.ts's
// own throttle comments).
const BUY_FILL_POLL_ATTEMPTS = 6;
const BUY_FILL_POLL_DELAY_MS = 2500;

async function waitForPrismBuyFill(orderId: string, tradingSymbol: string, userId: string): Promise<number> {
    const prism = Prism.getInstance();
    for (let attempt = 1; attempt <= BUY_FILL_POLL_ATTEMPTS; attempt++) {
        const { status, fillPrice } = await prism.getOrderStatus(orderId);
        if (status === 'COMPLETE') {
            if (!fillPrice) throw new Error(`Prism buy ${orderId} (${tradingSymbol}, ${userId}) reported COMPLETE but no fill price - manual review required`);
            return fillPrice;
        }
        if (status === 'REJECTED' || status === 'CANCELED' || status === 'CANCELLED') {
            throw new Error(`Prism buy ${orderId} (${tradingSymbol}, ${userId}) ${status} - not filled`);
        }
        if (attempt < BUY_FILL_POLL_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, BUY_FILL_POLL_DELAY_MS));
    }
    try {
        await Prism.getInstance().cancelOrder(orderId);
        Log.log(`[order] Prism buy ${orderId} (${tradingSymbol}, ${userId}) did not fill within ${BUY_FILL_POLL_ATTEMPTS * BUY_FILL_POLL_DELAY_MS}ms - cancelled`);
    } catch (e) {
        Log.log(`[order] Prism buy ${orderId} (${tradingSymbol}, ${userId}) did not fill and cancel ALSO failed - re-checking status before giving up (may have just filled):`, e);
    }
    // Re-check status AFTER the cancel attempt, rather than assuming "not
    // filled" the moment polling ran out - the order can genuinely fill in
    // the race window between the last poll above and this cancel call (or
    // the cancel call can itself fail precisely BECAUSE the order just
    // completed). Throwing unconditionally here would silently orphan a real
    // fill: recordFill would never run, so the position would be live and
    // unprotected at the broker with no exit ever placed, invisible to
    // reconcile() too since it only inspects local bookkeeping state, never
    // live broker state - the exact "stuck position, no exit" failure class
    // this whole fill-verification path exists to prevent.
    const finalCheck = await Prism.getInstance().getOrderStatus(orderId);
    if (finalCheck.status === 'COMPLETE') {
        if (!finalCheck.fillPrice) throw new Error(`Prism buy ${orderId} (${tradingSymbol}, ${userId}) filled in the cancel race window but reported no fill price - manual review required`);
        Log.log(`[order] Prism buy ${orderId} (${tradingSymbol}, ${userId}) filled in the cancel race window - treating as filled at ${finalCheck.fillPrice}`);
        return finalCheck.fillPrice;
    }
    throw new Error(`Prism buy ${orderId} (${tradingSymbol}, ${userId}) did not fill within ${BUY_FILL_POLL_ATTEMPTS * BUY_FILL_POLL_DELAY_MS}ms - treating as not filled`);
}

export async function buyOnPrism(request: BuyRequest): Promise<Trade> {
    const { userId, tradingSymbol, instrumentId, quantity, stopLossPoints, exchange } = request;
    if (stopLossPoints && stopLossPoints > 0) {
        Log.log(`[order] Buying (Prism) ${tradingSymbol} qty=${quantity} for ${userId} via cover order (sl=${stopLossPoints})`);
        const response = await Prism.getInstance().placeCoverOrder(tradingSymbol, quantity, stopLossPoints);
        if (!response) throw new Error(`placeCoverOrder failed for ${tradingSymbol}`);

        const trade = new Trade();
        trade.tsym = response.contract;
        trade.token = response.token;
        trade.quantity = response.qty;
        trade.price = response.price;
        trade.lastTradePrice = response.price;
        trade.action = 'Buy';
        trade.status = 'COMPLETE';
        trade.user = userId;
        trade.broker = 'prism';
        trade.stopLossPrice = response.price - stopLossPoints;

        if (response.norenordno) {
            trade.prismCoverOrderNo = response.norenordno;
            // Broker owns the actual exit - watch-only so the frontend's live
            // P&L still moves with the market, same pattern zerodhaExecutor/
            // antExecutor use for their own GTT/bracket entries.
            // 'NSE' in Exchange is Breeze-only - Prism never trades NSE cash
            // through this path, cast is safe.
            if (trade.token) exitMonitor.registerTrade(trade, request.exchange as 'NFO' | 'BFO', 'prism', true);
        }

        await bookkeeping.recordFill(trade);
        return trade;
    }
    // No protection requested - verified single order (NOT the shared
    // buyContract() helper above, which has no fill check - see
    // waitForPrismBuyFill's comment).
    Log.log(`[order] Buying (Prism) ${tradingSymbol} qty=${quantity} for ${userId} via verified limit order`);
    const prism = Prism.getInstance();
    const quote = await prism.getStockOptionQuote(tradingSymbol);
    const limitPrice = quote.ltp;
    const { orderId } = await prism.placeLimitBuyBare(tradingSymbol, instrumentId, quantity, limitPrice, userId, (exchange as 'NFO' | 'BFO') ?? 'NFO');
    const fillPrice = await waitForPrismBuyFill(orderId, tradingSymbol, userId);

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentId;
    trade.quantity = quantity;
    trade.price = fillPrice;
    trade.lastTradePrice = fillPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'prism';
    trade.brokerOrderId = orderId;

    await bookkeeping.recordFill(trade);
    return trade;
}

export async function squareOffOnPrism(userId: string, tsym: string, quantity: number): Promise<Trade> {
    const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);
    if (existing?.prismCoverOrderNo) {
        Log.log(`[order] Square-off ${tsym} qty=${quantity} for ${userId} via Prism exitCoverOrder (${existing.prismCoverOrderNo})`);
        await Prism.getInstance().exitCoverOrder(existing.prismCoverOrderNo);

        const trade = new Trade();
        trade.tsym = tsym;
        trade.token = existing.token;
        trade.quantity = quantity;
        trade.action = 'Sell';
        trade.status = 'COMPLETE';
        trade.user = userId;
        trade.broker = 'prism';
        // No separate fill-price signal from exit_order itself - same
        // last-seen-price fallback antExecutor.squareOffOnAnt uses for its
        // own exitBracketOrder path.
        trade.price = existing.lastTradePrice ?? existing.price ?? 0;

        await bookkeeping.recordFill(trade);
        return trade;
    }
    return sellContract(userId, tsym, quantity);
}

// Returns immediately with {orderId} - fill arrives later via
// pollPendingPrismLimitOrders. Mirrors placeLimitSellBareOnAnt exactly -
// BulkPcrStrategy's target-hit exit on Prism.
export async function placeLimitSellBareOnPrism(userId: string, tradingSymbol: string, instrumentId: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    Log.log(`[order] Bare Prism limit sell ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderId } = await Prism.getInstance().placeLimitSellBare(tradingSymbol, instrumentId, quantity, price, userId, exchange);
    trackPendingPrismLimitOrder({ orderId, userId, tradingSymbol, instrumentId, quantity, exchange, action: 'Sell' });
    return { orderId };
}

export async function cancelOrderOnPrism(orderId: string): Promise<void> {
    await Prism.getInstance().cancelOrder(orderId);
}

export async function getFillPriceOnPrism(orderId: string): Promise<number> {
    // requestedPrice fallback of 0 is a real gap when called standalone (not
    // via buyOnPrism, which always has a real requested price to fall back
    // to) - acceptable for now since nothing calls this outside buyOnPrism
    // yet; flagged rather than silently hidden.
    return Prism.getInstance().getOrderFillPrice(orderId, 0);
}

export async function getPositionsOnPrism(): Promise<BrokerPosition[]> {
    const positions = await Prism.getInstance().getPositions();
    return positions.map((p: any) => ({
        tradingSymbol: p.tsym,
        instrumentId: p.token,
        quantity: Number(p.netqty ?? 0),
        avgPrice: Number(p.netavgprc ?? 0),
        exchange: p.exch ?? 'NFO',
    }));
}

export async function getTradesOnPrism(): Promise<Trade[]> {
    return Prism.getInstance().getTradeList();
}

// No session-validity concept exists in Prism/RestAPI.ts today (unlike
// Zerodha.hasValidSession's real token check) - always reports valid until a
// real check is worth adding. See ToDo.md.
export async function hasValidSessionOnPrism(): Promise<boolean> {
    return true;
}
