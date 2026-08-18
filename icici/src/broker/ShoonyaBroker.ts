import { Broker, OrderRight, OrderAction } from './Broker';
import { NiftyQuote, Trade, Order, OrderInfo, OrderStatus } from '../model/model';
import { UserContext } from '../user';
import NorenRestApi from '../prism/RestAPI';
import Config from '../prism/config';
import fs from 'fs';
import path from 'path';

/**
 * Shoonya broker implementation — thin adapter over the already-working `NorenRestApi` singleton.
 * Delegates to existing Noren primitives (login, place_order, get_quotes, etc.) without reinvention.
 * Includes local quantity-sizing logic and a small token↔tsym lookup against the NFO symbols file.
 */
export default class ShoonyaBroker implements Broker {
  readonly name = 'Shoonya';
  private trades: Trade[] = [];
  private nfoSymbolsCache: Map<string, string> | null = null;

  private getNFOSymbols(): Map<string, string> {
    if (this.nfoSymbolsCache) return this.nfoSymbolsCache;

    const map = new Map<string, string>();
    const filePath = path.join(__dirname, '..', '..', 'NFO_symbols.txt');
    if (!fs.existsSync(filePath)) {
      console.warn(`NFO_symbols.txt not found at ${filePath}`);
      return map;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    for (const line of lines) {
      const [token, tsym] = line.trim().split('|');
      if (token && tsym) map.set(token, tsym);
    }

    this.nfoSymbolsCache = map;
    return map;
  }

  private tokenToTsym(token: string): string {
    const map = this.getNFOSymbols();
    return map.get(token) || token;
  }

  private calculateQty(price: number | undefined, userContext?: UserContext): number {
    if (userContext?.investmentMode === 'investmentAmount' && userContext.investmentAmount && price) {
      return Math.floor(userContext.investmentAmount / price / (Config.lotCount || 1));
    }
    return userContext?.lotCount || Config.lotCount || 1;
  }

  // --- session / auth ---
  async connect(): Promise<void> {
    const api = NorenRestApi;
    await api.start_websocket({
      socket_open: () => console.log('[Shoonya] WebSocket opened'),
      socket_close: () => console.log('[Shoonya] WebSocket closed'),
      socket_error: (err: any) => console.error('[Shoonya] WebSocket error:', err),
      quote: (data: any) => console.log('[Shoonya] Quote:', data),
      order: (data: any) => console.log('[Shoonya] Order update:', data),
      notification: (data: any) => console.log('[Shoonya] Notification:', data),
    });
  }

  getOAuthURL(): string {
    return NorenRestApi.getOAuthURL();
  }

  async requestOtp(): Promise<void> {
    await NorenRestApi.request_otp();
  }

  async login(otp: string): Promise<void> {
    await NorenRestApi.login(otp);
  }

  async loginWithGenAcsTok(code: string): Promise<void> {
    await NorenRestApi.loginWithGenAcsTok(code);
  }

  async logout(): Promise<void> {
    await NorenRestApi.logout();
  }

  // --- market data ---
  async getQuote(index: string): Promise<NiftyQuote> {
    const indexTokens: Record<string, string> = { NIFTY: '26000', BANKNIFTY: '26009', FINNIFTY: '26037' };
    const token = indexTokens[index];
    if (!token) throw new Error(`Unknown index: ${index}`);
    const resp = await NorenRestApi.get_quotes('NSE', token);
    return NiftyQuote.fromPrism(resp);
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
    const resp = await NorenRestApi.get_quotes('NSE', symbol);
    return NiftyQuote.fromPrism(resp);
  }

  async getOptionQuote(token: string): Promise<NiftyQuote> {
    const resp = await NorenRestApi.get_quotes('NFO', token);
    return NiftyQuote.fromPrism(resp);
  }

  async subscribeNifty(): Promise<void> {
    // Touchline quote subscription retired from Shoonya/Prism - ANT is now
    // the platform's quote source (see AntStream).
  }

  async getToken(tsym: string): Promise<string> {
    const resp = await NorenRestApi.searchscrip(tsym);
    return resp.data.token;
  }

  // --- orders ---
  async buyContract(contract: string, qty?: number, price?: number, userContext?: UserContext): Promise<OrderInfo> {
    const quantity = qty || this.calculateQty(price, userContext);
    return this.sendLimitOrder(contract, price || 0, 'call', 'buy', quantity, userContext);
  }

  async buyOrder(symbol: string, qty: number, price: number, userContext?: UserContext): Promise<OrderInfo> {
    return this.sendLimitOrder(symbol, price, 'call', 'buy', qty, userContext);
  }

  async sellOrder(symbol: string, qty: number, price: number, userContext?: UserContext): Promise<OrderInfo> {
    return this.sendLimitOrder(symbol, price, 'put', 'sell', qty, userContext);
  }

  async sendLimitOrder(tsym: string, price: number, _right: OrderRight, action: OrderAction, quantity: number, _userContext?: UserContext): Promise<OrderInfo> {
    const trantype = action.toUpperCase() === 'SELL' ? 'S' : 'B';
    const prctyp = price > 0 ? 'LMT' : 'MKT';
    const prc = price > 0 ? price : undefined;

    const order = {
      trantype,
      prd: 'M',
      exch: 'NFO',
      tsym,
      qty: quantity.toString(),
      prctyp,
      ...(prc && { prc }),
    };

    await NorenRestApi.place_order(order);

    return {
      token: tsym,
      contract: tsym,
      qty: quantity,
      price,
      lastOrderedPrice: price,
      status: OrderStatus.ORDERED,
    };
  }

  async squareOffOrder(token: string, qty: number, _user?: string, price?: number): Promise<void> {
    const tsym = this.tokenToTsym(token);
    const prctyp = price ? 'LMT' : 'MKT';
    const order = {
      trantype: 'S',
      prd: 'M',
      exch: 'NFO',
      tsym,
      qty: qty.toString(),
      prctyp,
      ...(price && { prc: price }),
    };

    await NorenRestApi.place_order(order);
  }

  async getOrders(): Promise<Order[]> {
    const resp = await NorenRestApi.get_orderbook();
    const orders = Array.isArray(resp) ? resp : resp?.data || [];
    return orders
      .filter((o: any) => o.status && o.status.toUpperCase() !== 'COMPLETE')
      .map((o: any) => Order.fromPrism(o));
  }

  getTradeList(): Trade[] {
    return this.trades;
  }

  async refreshTradeList(): Promise<Trade[]> {
    const resp = await NorenRestApi.get_positions();
    const positions = Array.isArray(resp) ? resp : resp?.data || [];
    this.trades = positions
      .filter((p: any) => parseInt(p.netqty || '0') > 0)
      .map((p: any) => Trade.fromPrism(p));
    return this.trades;
  }
}
