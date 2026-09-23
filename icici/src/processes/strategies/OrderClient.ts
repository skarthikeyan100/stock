import net from 'net';
import Log from '../../util/Log';
import { writeJsonLine, readJsonLines } from '../../ipc/jsonLines';
import { ORDER_SOCKET_PATH, OrderRequest, OrderRequestType, OrderResponse, FillNotification, OrderCancelledNotification } from '../../ipc/orderProtocol';

// The strategies process's only path to broker execution - no Prism/Zerodha
// dependency lives here at all, by design (see plan). Connects to `order`'s
// Unix socket as a client and reconnects on drop, since `order` is the stable
// side and `strategies` is the one that gets restarted on every code change.
// Also used directly by server.ts (the `frontend` process) - not strategy-only
// despite the file's location, see src/server.ts's imports.

type FillHandler = (userId: string, trade: any) => void;
type PositionsChangedHandler = () => void;
type CancelledHandler = (userId: string, notification: OrderCancelledNotification) => void;

class OrderClient {
    private static instance: OrderClient;
    // Default timeout for a single request()/response round trip over the
    // IPC socket to the `order` process. Must comfortably exceed the
    // slowest legitimate round trip: an order-placing request can
    // internally wait for a broker fill confirmation with its own budget of
    // up to ~60s (see AntOrderNotifyStream.waitForFill's 60000ms default in
    // src/ant/AntOrderNotifyStream.ts and Zerodha.getFillPrice's 12
    // attempts * 5000ms poll in src/zerodha/Zerodha.ts), stacked on top of
    // the ANT HTTP call itself (capped at 15s - see ANT_HTTP_TIMEOUT_MS in
    // src/ant/ANT.ts). 90s gives headroom above that combined ~75s worst
    // case without leaving a wedged `order` process able to block a
    // strategy indefinitely. Overridable via ORDER_IPC_TIMEOUT_MS (mirrors
    // ORDER_SOCKET_PATH's env-override convention in
    // src/ipc/orderProtocol.ts). Deliberately not `readonly` - TypeScript's
    // `private`/`static` are compile-time-only and don't survive an `as
    // any` cast, so a test can override this directly instead of waiting
    // out the real production value (see src/test/orderClientTimeout.test.ts).
    private static REQUEST_TIMEOUT_MS = Number(process.env.ORDER_IPC_TIMEOUT_MS) || 90000;
    private socket: net.Socket | null = null;
    private connected = false;
    private pending: Map<string, { resolve: (r: OrderResponse) => void; reject: (e: Error) => void }> = new Map();
    private fillHandlers: FillHandler[] = [];
    private positionsChangedHandlers: PositionsChangedHandler[] = [];
    private cancelledHandlers: CancelledHandler[] = [];
    private nextId = 0;

    static getInstance(): OrderClient {
        if (!OrderClient.instance) OrderClient.instance = new OrderClient();
        return OrderClient.instance;
    }

    onFill(handler: FillHandler) {
        this.fillHandlers.push(handler);
    }

    onPositionsChanged(handler: PositionsChangedHandler) {
        this.positionsChangedHandlers.push(handler);
    }

    onCancelled(handler: CancelledHandler) {
        this.cancelledHandlers.push(handler);
    }

    // For short-lived, one-shot callers (e.g. GapScreenerCoverOrder.ts) that
    // need to know whether the initial connect() attempt succeeded before
    // issuing a request, rather than relying on request()'s "Not connected"
    // rejection or connect()'s indefinite background retry loop.
    isConnected(): boolean {
        return this.connected;
    }

    connect(): void {
        this.socket = net.createConnection(ORDER_SOCKET_PATH);

        this.socket.on('connect', () => {
            this.connected = true;
            Log.log('[strategies] Connected to order process');
        });

        readJsonLines(
            this.socket,
            (msg) => {
                if (msg.kind === 'response') {
                    const waiter = this.pending.get(msg.id);
                    if (waiter) {
                        this.pending.delete(msg.id);
                        waiter.resolve(msg as OrderResponse);
                    }
                } else if (msg.kind === 'fill') {
                    const fill = msg as FillNotification;
                    for (const h of this.fillHandlers) h(fill.userId, fill.trade);
                } else if (msg.kind === 'positionsChanged') {
                    for (const h of this.positionsChangedHandlers) h();
                } else if (msg.kind === 'cancelled') {
                    const cancelled = msg as OrderCancelledNotification;
                    for (const h of this.cancelledHandlers) h(cancelled.userId, cancelled);
                }
            },
            (line, err) => Log.log('[strategies] Failed to parse order-process message:', line, err)
        );

        this.socket.on('close', () => {
            this.connected = false;
            Log.log('[strategies] Disconnected from order process, retrying in 2s...');
            // Reject anything already in flight on this now-dead socket - it will
            // never get a response (confirmed live: a request written right as a
            // startup/reconnect race closed the old socket just sat in `pending`
            // forever, with no timeout, permanently wedging the caller - e.g.
            // ContinuousStrategy's `this.ordered` never resetting after a T1
            // attempt landed in this window).
            for (const waiter of this.pending.values()) waiter.reject(new Error('Order process connection closed'));
            this.pending.clear();
            setTimeout(() => this.connect(), 2000);
        });
        this.socket.on('error', (e) => Log.log('[strategies] Order socket error:', e));
    }

    private request(type: OrderRequestType, userId: string, payload: any, timeoutMs: number = OrderClient.REQUEST_TIMEOUT_MS): Promise<OrderResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) return reject(new Error('Not connected to order process'));
            const id = String(this.nextId++);
            // If `order` never replies (hung broker call inside it, a
            // dropped/malformed response, a wedged process that's still
            // technically connected), this used to leave the caller awaiting
            // forever - the socket 'close' handler above only covers the
            // socket actually dropping, not "still open but silent". See
            // plans/bug-09-no-timeout-broker-http-ipc.md.
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    Log.log(`[strategies] Order request '${type}' (id=${id}) timed out after ${timeoutMs}ms - order process may be stuck`);
                    reject(new Error(`Order process request '${type}' timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (r: OrderResponse) => { clearTimeout(timer); resolve(r); },
                reject: (e: Error) => { clearTimeout(timer); reject(e); },
            });
            const req: OrderRequest = { kind: 'request', id, type, userId, payload };
            writeJsonLine(this.socket, req);
        });
    }

    async buyIndex(userId: string, payload: { niftyLtp: number; right: string; quantity: number; index?: 'NIFTY' | 'SENSEX'; targetPoints?: number; stopLossPoints?: number; strike?: number; expiry?: string; skipIfOpenPositionType?: 'CE' | 'PE' }): Promise<any> {
        const res = await this.request('buyIndex', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async squareOff(userId: string, payload: { tsym?: string; token?: string; quantity?: number; exchange?: 'NFO' | 'BFO' }): Promise<any> {
        const res = await this.request('squareOff', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async canPlaceOrder(userId: string): Promise<{ allowed: boolean; reason?: string }> {
        const res = await this.request('canPlaceOrder', userId, {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    // Prism/Shoonya contract-by-price-range path (secondary broker path - see
    // src/processes/order/prismExecutor.ts). userId isn't meaningful for the
    // read-only lookups but the wire protocol always carries one.
    async getContractByPriceRange(userId: string, right: string): Promise<string | null> {
        const res = await this.request('getContractByPriceRange', userId, { right });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async calculateRight(userId: string, ltp?: number): Promise<string> {
        const res = await this.request('calculateRight', userId, { ltp });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getToken(userId: string, contract: string): Promise<string> {
        const res = await this.request('getToken', userId, { contract });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getNiftyQuote(userId: string): Promise<any> {
        const res = await this.request('getNiftyQuote', userId, {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getOptionQuote(userId: string, token: string): Promise<any> {
        const res = await this.request('getOptionQuote', userId, { token });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getStockOptionQuote(userId: string, contract: string): Promise<any> {
        const res = await this.request('getStockOptionQuote', userId, { contract });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async buyContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
        const res = await this.request('buyContract', userId, { contract, quantity, price });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async sellContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
        const res = await this.request('sellContract', userId, { contract, quantity, price });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async stats(userId = 'Default'): Promise<{ trades: any[]; closedTrades: any[]; userPnL: Record<string, number> }> {
        const res = await this.request('stats', userId, {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async manualBuy(userId: string, payload: { index?: 'NIFTY' | 'SENSEX'; right?: string; contract?: string; strikePrice?: number; price?: number; quantity?: number; targetPoints?: number; stopLossPoints?: number }): Promise<any> {
        const res = await this.request('manualBuy', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async setTargetStopLoss(userId: string, token: string, targetPoints: number, stopLossPoints: number): Promise<void> {
        const res = await this.request('setTargetStopLoss', userId, { token, targetPoints, stopLossPoints });
        if (!res.ok) throw new Error(res.error);
    }

    // ANT (AliceBlue) order path - see src/processes/order/antExecutor.ts.
    async antBuyIndex(userId: string, payload: { niftyLtp: number; right: string; quantity: number; index?: 'NIFTY' | 'SENSEX'; targetPoints?: number; stopLossPoints?: number; strike?: number; expiry?: string }): Promise<any> {
        const res = await this.request('antBuyIndex', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async antManualBuy(userId: string, payload: { index?: 'NIFTY' | 'SENSEX'; right?: string; contract?: string; strikePrice?: number; quantity?: number; targetPoints?: number; stopLossPoints?: number }): Promise<any> {
        const res = await this.request('antManualBuy', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    // ICICI Breeze order path - see src/processes/order/breezeExecutor.ts.
    async breezeBuyIndex(userId: string, payload: { right: string; quantity?: number; targetPoints?: number; stopLossPoints?: number }): Promise<any> {
        const res = await this.request('breezeBuyIndex', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async breezeSquareOff(userId: string, payload: { tsym: string; quantity: number }): Promise<any> {
        const res = await this.request('breezeSquareOff', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    // Broker-agnostic freeze-quantity-chunked buy/squareoff - see
    // src/processes/order/chunkedOrder.ts. BulkPcrStrategy's use case (13975
    // qty = 8 sequential chunks against NIFTY's 1755 freeze cap). Each chunk
    // is one full broker round trip; on the (fixed) square-off side each
    // chunk can itself retry/re-price up to ~60s if it doesn't fill
    // immediately (see breezeExecutor.ts's squareOffOnBreeze), and on the
    // entry/buy side (deliberately not given the same retry treatment - see
    // that file's scope note) a single chunk can still take up to ~90s
    // (waitForBreezeFill's un-overridden default) before throwing outright.
    // 8 chunks worst-case on either side is well past the default 90s IPC
    // timeout used by every other (single-order) request type - exactly what
    // left a chunk resting unfilled and the whole call timing out live on
    // 2026-09-21 before a single retry was even possible. 15 minutes covers
    // both sides' theoretical worst case (8x60s=8min sell, 8x90s=12min buy)
    // with margin; every other request type keeps failing fast at the
    // default, since only these two are structurally multi-chunk/variable-
    // duration.
    private static CHUNKED_ORDER_TIMEOUT_MS = 15 * 60 * 1000;

    // `broker`, when supplied, overrides the per-userId broker resolution for
    // this one call (see getBrokerExecutor) - lets a single strategy identity
    // place independent orders on several brokers at once (BulkPcrStrategy's
    // multi-broker support). Omitted by every other caller, which keeps
    // today's per-userId resolution unchanged.
    async chunkedBuyIndex(userId: string, payload: { right: string; quantity: number; freezeQuantity?: number; niftyLtp?: number; broker?: 'zerodha' | 'ant' | 'breeze' }): Promise<any> {
        const res = await this.request('chunkedBuyIndex', userId, payload, OrderClient.CHUNKED_ORDER_TIMEOUT_MS);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async chunkedSquareOff(userId: string, payload: { tsym: string; quantity: number; freezeQuantity?: number; broker?: 'zerodha' | 'ant' | 'breeze' }): Promise<any> {
        const res = await this.request('chunkedSquareOff', userId, payload, OrderClient.CHUNKED_ORDER_TIMEOUT_MS);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    // LIMIT-priced counterpart of chunkedSquareOff - returns once the resting
    // orders are placed, not once filled (see chunkedOrder.ts's
    // squareOffLimitChunked). Reuses the same generous chunked timeout since
    // placement is still up to 8 sequential broker calls, even though it
    // shouldn't normally take anywhere near as long as a fill-waiting call.
    async chunkedSquareOffLimit(userId: string, payload: { tsym: string; instrumentId: string; quantity: number; price: number; freezeQuantity?: number; broker?: 'zerodha' | 'ant' | 'breeze' }): Promise<any> {
        const res = await this.request('chunkedSquareOffLimit', userId, payload, OrderClient.CHUNKED_ORDER_TIMEOUT_MS);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async antPlaceCoverOrder(userId: string, payload: { tradingSymbol: string; instrumentId: string; quantity: number; exchange: 'NFO' | 'BFO'; transactionType: 'BUY' | 'SELL'; stopLossPoints: number }): Promise<any> {
        const res = await this.request('antPlaceCoverOrder', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async antSquareOff(userId: string, payload: { tsym?: string; token?: string; quantity?: number; exchange?: 'NFO' | 'BFO' }): Promise<any> {
        const res = await this.request('antSquareOff', userId, payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async antSetTargetStopLoss(userId: string, token: string, targetPoints: number, stopLossPoints: number): Promise<void> {
        const res = await this.request('antSetTargetStopLoss', userId, { token, targetPoints, stopLossPoints });
        if (!res.ok) throw new Error(res.error);
    }

    async reloadSession(userId = 'Default'): Promise<void> {
        const res = await this.request('reloadSession', userId, {});
        if (!res.ok) throw new Error(res.error);
    }

    async reloadUserLimits(userId = 'Default'): Promise<void> {
        const res = await this.request('reloadUserLimits', userId, {});
        if (!res.ok) throw new Error(res.error);
    }

    async refreshTradeList(userId = 'Default'): Promise<any> {
        const res = await this.request('refreshTradeList', userId, {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getOrders(userId = 'Default'): Promise<any> {
        const res = await this.request('getOrders', userId, {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async updateUserSettings(userId: string, settings: { lossLimit: number; lotLimit?: number; maxInvestment?: number; investmentMode?: string; investmentAmount?: number; useGTT?: boolean; broker?: 'zerodha' | 'ant' | 'breeze'; perOrderCap?: number; allottedCapital?: number; targetPoints?: number; stopLossPoints?: number }): Promise<void> {
        const res = await this.request('updateUserSettings', userId, settings);
        if (!res.ok) throw new Error(res.error);
    }

    // undefined result means "no per-user override" - caller falls back to
    // its own config default (see ContinuousStrategy.capitalCheck).
    async getUserAllottedCapital(userId: string): Promise<number | undefined> {
        const res = await this.request('getUserAllottedCapital', userId, {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async hasActiveTrade(userId: string): Promise<boolean> {
        const res = await this.request('hasActiveTrade', userId, {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getOpenTrades(userId: string): Promise<any[]> {
        const res = await this.request('openTrades', userId, {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async findToken(userId: string, index: string, depth: number, right: string): Promise<string> {
        const res = await this.request('findToken', userId, { index, depth, right });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async injectTrade(payload: { tsym: string; flqty: string; flprc: string; trantype: string }): Promise<any> {
        const res = await this.request('injectTrade', 'Default', payload);
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async connectPrism(userId = 'Default'): Promise<void> {
        const res = await this.request('connectPrism', userId, {});
        if (!res.ok) throw new Error(res.error);
    }

    async getIndexQuote(userId: string, index: 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY'): Promise<any> {
        const res = await this.request('getIndexQuote', userId, { index });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getStockQuote(userId: string, symbol: string): Promise<any> {
        const res = await this.request('getStockQuote', userId, { symbol });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    // Bare (unprotected, self-monitored) execution path used by LegManager
    // (ContinuousStrategy/SupportResistanceStrategy) - see
    // src/processes/order/zerodhaExecutor.ts/breezeExecutor.ts. Bypasses the
    // GTT/exitMonitor bracket the other entry points (buyIndex, manualBuy) go
    // through - these strategies self-monitor every leg from live option ticks
    // instead. Broker is resolved server-side in orderProcess.ts, keyed off
    // userId (a strategy's pseudo-user id) via bookkeeping.getUserBroker - the
    // same per-user convention buyIndex/manualBuy/squareOff already use for
    // real users, so this class stays entirely broker-agnostic.
    async buyContractBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO', price?: number): Promise<any> {
        const res = await this.request('buyContractBare', userId, { tradingSymbol, instrumentToken, quantity, exchange, price });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async sellContractBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<any> {
        const res = await this.request('sellContractBare', userId, { tradingSymbol, instrumentToken, quantity, exchange });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    // Returns immediately with {orderId} - the fill arrives later as a normal
    // fill notification once pendingLimitOrders.ts's/breezePendingLimitOrders.ts's
    // poller sees it complete.
    async placeLimitBuyBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO'): Promise<{ orderId: string }> {
        const res = await this.request('placeLimitBuyBare', userId, { tradingSymbol, instrumentToken, quantity, price, exchange });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async cancelOrderBare(userId: string, orderId: string): Promise<void> {
        const res = await this.request('cancelOrderBare', userId, { orderId });
        if (!res.ok) throw new Error(res.error);
    }

    async getContractByPriceRangeBare(userId: string, underlyingLtp: number, optionType: 'CE' | 'PE', minPremium: number, index: 'NIFTY' | 'SENSEX' = 'NIFTY', excludeStrikes: number[] = []): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number; exchange: 'NFO' | 'BFO'; strike: number; premium: number; antToken: string }> {
        const res = await this.request('getContractByPriceRangeBare', userId, { underlyingLtp, optionType, minPremium, index, excludeStrikes });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getPCR(userId: string, underlying: string, spot: number, window: number): Promise<number> {
        const res = await this.request('getPCR', userId, { underlying, spot, window });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getATMTokens(userId: string, niftyLtp: number, index: string = 'NIFTY'): Promise<{ ce: { token: string; tradingSymbol: string }; pe: { token: string; tradingSymbol: string } }> {
        const res = await this.request('getATMTokens', userId, { niftyLtp, index });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }
}

export default OrderClient;
