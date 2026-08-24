import net from 'net';
import Log from '../../util/Log';
import { writeJsonLine, readJsonLines } from '../../ipc/jsonLines';
import { ORDER_SOCKET_PATH, OrderRequest, OrderRequestType, OrderResponse, FillNotification } from '../../ipc/orderProtocol';

// The strategies process's only path to broker execution - no Prism/Zerodha
// dependency lives here at all, by design (see plan). Connects to `order`'s
// Unix socket as a client and reconnects on drop, since `order` is the stable
// side and `strategies` is the one that gets restarted on every code change.
// Also used directly by server.ts (the `frontend` process) - not strategy-only
// despite the file's location, see src/server.ts's imports.

type FillHandler = (userId: string, trade: any) => void;
type PositionsChangedHandler = () => void;

class OrderClient {
    private static instance: OrderClient;
    private socket: net.Socket | null = null;
    private pending: Map<string, { resolve: (r: OrderResponse) => void; reject: (e: Error) => void }> = new Map();
    private fillHandlers: FillHandler[] = [];
    private positionsChangedHandlers: PositionsChangedHandler[] = [];
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

    connect(): void {
        this.socket = net.createConnection(ORDER_SOCKET_PATH);

        this.socket.on('connect', () => Log.log('[strategies] Connected to order process'));

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
                }
            },
            (line, err) => Log.log('[strategies] Failed to parse order-process message:', line, err)
        );

        this.socket.on('close', () => {
            Log.log('[strategies] Disconnected from order process, retrying in 2s...');
            setTimeout(() => this.connect(), 2000);
        });
        this.socket.on('error', (e) => Log.log('[strategies] Order socket error:', e));
    }

    private request(type: OrderRequestType, userId: string, payload: any): Promise<OrderResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket) return reject(new Error('Not connected to order process'));
            const id = String(this.nextId++);
            this.pending.set(id, { resolve, reject });
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

    async manualBuy(userId: string, payload: { index?: 'NIFTY' | 'SENSEX'; right?: string; contract?: string; strikePrice?: number; price?: number; quantity?: number }): Promise<any> {
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

    async updateUserSettings(userId: string, settings: { lossLimit: number; lotLimit?: number; maxInvestment?: number; investmentMode?: string; investmentAmount?: number; useGTT?: boolean; perOrderCap?: number }): Promise<void> {
        const res = await this.request('updateUserSettings', userId, settings);
        if (!res.ok) throw new Error(res.error);
    }

    async hasActiveTrade(userId: string): Promise<boolean> {
        const res = await this.request('hasActiveTrade', userId, {});
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
}

export default OrderClient;
