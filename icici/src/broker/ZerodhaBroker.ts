import { Broker, OrderRight, OrderAction } from './Broker';
import { NiftyQuote, Trade, Order, OrderInfo, OrderStatus } from '../model/model';
import { UserContext } from '../user';
import { KiteConnect, Connect, Instrument, Exchanges, OrderType, TransactionType } from 'kiteconnect';
import fs from 'fs';
import path from 'path';

/**
 * Zerodha broker implementation — built on the official `kiteconnect` npm package.
 * Ports patterns from the working reference server at ~/work/zerodha/src/kite.ts.
 * Manages session via optional `.zerodha_session.json` file (kept gitignored, not committed).
 */
export default class ZerodhaBroker implements Broker {
  readonly name = 'Zerodha';
  private kc: Connect;
  private trades: Trade[] = [];
  private instrumentsCache: Map<Exchanges, Instrument[]> = new Map();
  private instrumentsCacheDate: string | null = null;
  private sessionFile = path.join(__dirname, '..', '..', '.zerodha_session.json');

  // Index → Kite underlying symbol mapping
  private readonly UNDERLYING_SYMBOL: Record<string, string> = {
    NIFTY: 'NSE:NIFTY 50',
    BANKNIFTY: 'NSE:NIFTY BANK',
    FINNIFTY: 'NSE:NIFTY FIN SERVICE',
    SENSEX: 'BSE:SENSEX',
  };

  // Index → exchange mapping
  private readonly INDEX_EXCHANGE: Record<string, Exchanges> = {
    NIFTY: 'NFO',
    BANKNIFTY: 'NFO',
    FINNIFTY: 'NFO',
    SENSEX: 'BFO',
  };

  constructor() {
    this.kc = new KiteConnect({ api_key: process.env.ZERODHA_API_KEY || '' });
    this.loadSession();
  }

  private loadSession(): void {
    if (!fs.existsSync(this.sessionFile)) return;
    try {
      const { access_token } = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
      if (access_token) this.kc.setAccessToken(access_token);
    } catch (e) {
      console.error('[Zerodha] Failed to load session:', e);
    }
  }

  private saveSession(accessToken: string): void {
    try {
      fs.writeFileSync(this.sessionFile, JSON.stringify({ access_token: accessToken }));
    } catch (e) {
      console.error('[Zerodha] Failed to save session:', e);
    }
  }

  private async getExchangeInstruments(exchange: Exchanges): Promise<Instrument[]> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.instrumentsCacheDate !== today) {
      this.instrumentsCache.clear();
      this.instrumentsCacheDate = today;
    }
    let cached = this.instrumentsCache.get(exchange);
    if (!cached) {
      cached = await this.kc.getInstruments(exchange);
      this.instrumentsCache.set(exchange, cached);
    }
    return cached;
  }

  private async findBySymbol(tradingsymbol: string): Promise<Instrument> {
    const exchanges = new Set(Object.values(this.INDEX_EXCHANGE));
    for (const exchange of exchanges) {
      const instruments = await this.getExchangeInstruments(exchange);
      const match = instruments.find((i) => i.tradingsymbol === tradingsymbol);
      if (match) return match;
    }
    throw new Error(`Contract ${tradingsymbol} not found in NFO/BFO instruments`);
  }


  private mapToNiftyQuote(quotes: Record<string, any>, symbol?: string): NiftyQuote {
    const key = symbol || Object.keys(quotes)[0];
    const q = quotes[key] || {};
    const quote = new NiftyQuote();
    quote.ltp = q.last_price || 0;
    quote.open = q.ohlc?.open || 0;
    quote.high = q.ohlc?.high || 0;
    quote.low = q.ohlc?.low || 0;
    quote.close = q.ohlc?.close || 0;
    quote.prevClose = q.ohlc?.close || 0;
    quote.volume = q.volume || 0;
    if (q.depth?.buy) quote.buyQty = q.depth.buy.reduce((sum: number, b: any) => sum + (b.quantity || 0), 0);
    if (q.depth?.sell) quote.sellQty = q.depth.sell.reduce((sum: number, s: any) => sum + (s.quantity || 0), 0);
    return quote;
  }

  // --- session / auth ---
  getOAuthURL(): string {
    return this.kc.getLoginURL();
  }

  async requestOtp(): Promise<void> {
    // TODO: Kite Connect has no public endpoint for OTP login; only browser-redirect + loginWithGenAcsTok is real
    throw new Error('[Zerodha] OTP login not supported; use getOAuthURL() + loginWithGenAcsTok()');
  }

  async login(_otp: string): Promise<void> {
    // TODO: Kite Connect has no public endpoint for OTP login
    throw new Error('[Zerodha] OTP login not supported; use getOAuthURL() + loginWithGenAcsTok()');
  }

  async loginWithGenAcsTok(requestToken: string): Promise<void> {
    const apiSecret = process.env.ZERODHA_API_SECRET;
    if (!apiSecret) throw new Error('[Zerodha] ZERODHA_API_SECRET env var not set');
    const session = await this.kc.generateSession(requestToken, apiSecret);
    this.kc.setAccessToken(session.access_token);
    this.saveSession(session.access_token);
  }

  async logout(): Promise<void> {
    await this.kc.invalidateAccessToken();
    try {
      fs.unlinkSync(this.sessionFile);
    } catch {
      // ignore if file doesn't exist
    }
  }

  async connect(): Promise<void> {
    // TODO: real-time streaming needs KiteTicker (WebSocket), out of scope for this pass
    console.log('[Zerodha] connect() not implemented (needs WebSocket ticker)');
  }

  async subscribeNifty(): Promise<void> {
    // TODO: real-time streaming needs KiteTicker (WebSocket)
    console.log('[Zerodha] subscribeNifty() not implemented (needs WebSocket ticker)');
  }

  // --- market data ---
  async getQuote(index: string): Promise<NiftyQuote> {
    const symbol = this.UNDERLYING_SYMBOL[index];
    if (!symbol) throw new Error(`Unknown index ${index}`);
    const ltpResp = await this.kc.getLTP([symbol]);
    return this.mapToNiftyQuote(ltpResp, symbol);
  }

  async getNiftyQuote(): Promise<NiftyQuote> {
    return this.getQuote('NIFTY');
  }

  async getBankNiftyQuote(): Promise<NiftyQuote> {
    return this.getQuote('BANKNIFTY');
  }

  async getFinNiftyQuote(): Promise<NiftyQuote> {
    return this.getQuote('FINNIFTY');
  }

  async getStockQuote(symbol: string): Promise<NiftyQuote> {
    const ltpResp = await this.kc.getLTP(['NSE:' + symbol]);
    return this.mapToNiftyQuote(ltpResp);
  }

  async getOptionQuote(token: string): Promise<NiftyQuote> {
    const ltpResp = await this.kc.getLTP([token]);
    return this.mapToNiftyQuote(ltpResp);
  }

  async getToken(tsym: string): Promise<string> {
    // For simplicity, return the trading symbol as-is (Zerodha uses tradingsymbol as the token in many contexts)
    // A real implementation would look up via getInstruments() caching
    return tsym;
  }

  // --- orders ---
  async buyContract(contract: string, qty?: number, price?: number, userContext?: UserContext): Promise<OrderInfo> {
    const quantity = qty || (userContext?.lotCount ?? 1);
    return this.sendLimitOrder(contract, price || 0, 'call', 'buy', quantity, userContext);
  }

  async buyOrder(symbol: string, qty: number, price: number, userContext?: UserContext): Promise<OrderInfo> {
    return this.sendLimitOrder(symbol, price, 'call', 'buy', qty, userContext);
  }

  async sellOrder(symbol: string, qty: number, price: number, userContext?: UserContext): Promise<OrderInfo> {
    return this.sendLimitOrder(symbol, price, 'put', 'sell', qty, userContext);
  }

  async sendLimitOrder(
    tsym: string,
    price: number,
    _right: OrderRight,
    action: OrderAction,
    quantity: number,
    _userContext?: UserContext
  ): Promise<OrderInfo> {
    const instrument = await this.findBySymbol(tsym);
    const transactionType: TransactionType = action.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    let orderType: OrderType = 'MARKET';
    if (price > 0) orderType = 'LIMIT';

    const orderParams: any = {
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      transaction_type: transactionType,
      quantity,
      product: 'NRML',
      order_type: orderType,
    };
    if (price > 0) orderParams.price = price;
    if (orderType === 'MARKET') orderParams.market_protection = -1;

    await this.kc.placeOrder('regular', orderParams);

    return {
      token: instrument.instrument_token.toString(),
      contract: instrument.tradingsymbol,
      qty: quantity,
      price,
      lastOrderedPrice: price,
      status: OrderStatus.ORDERED,
    };
  }

  async squareOffOrder(token: string, qty: number, _user?: string, price?: number): Promise<void> {
    const instrument = await this.findBySymbol(token);
    const orderType: OrderType = price ? 'LIMIT' : 'MARKET';
    // Note: TS strictness requires casting despite the value being determined by the ternary above
    const orderParams: any = {
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      transaction_type: 'SELL',
      quantity: qty,
      product: 'NRML',
      order_type: orderType,
    };
    if (price) orderParams.price = price;
    if (orderType === 'MARKET') orderParams.market_protection = -1;

    await this.kc.placeOrder('regular', orderParams);
  }

  async getOrders(): Promise<Order[]> {
    const orders = await this.kc.getOrders();
    return orders
      .filter((o: any) => o.status !== 'COMPLETE')
      .map((o: any) => ({
        orderno: o.order_id,
        tsym: o.tradingsymbol,
        trantype: o.transaction_type,
        quantity: o.quantity,
        price: o.price,
        token: o.instrument_token?.toString() || '',
      } as Order));
  }

  getTradeList(): Trade[] {
    return this.trades;
  }

  async refreshTradeList(): Promise<Trade[]> {
    const positions = await this.kc.getPositions();
    const netPositions = positions.net || [];
    this.trades = netPositions
      .filter((p: any) => (p.quantity || 0) > 0)
      .map((p: any) => ({
        tsym: p.tradingsymbol,
        token: p.instrument_token?.toString() || '',
        stockCode: p.tradingsymbol.split(/\d+/)[0],
        expiryDate: '',
        strikePrice: '',
        right: 'call',
        action: 'Buy',
        quantity: p.quantity || 0,
        flqty: p.quantity || 0,
        price: p.average_price || 0,
        ltp: p.last_price || 0,
        strategy: 'manual',
        isPendingOrder: false,
        isBuyPending: false,
        isSellPending: false,
        lastTradePrice: p.last_price || 0,
        status: 'OPEN',
        targetPrice: 0,
        stopLossPrice: 0,
        targetPoints: 0,
        trailingDistance: 0,
        highWaterMark: p.last_price || 0,
        trailingActive: false,
        user: 'Default',
        open: true,
        realizedPnL: 0,
      } as Trade));
    return this.trades;
  }
}
