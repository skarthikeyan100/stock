import { Broker, OrderRight, OrderAction } from './Broker';
import { NiftyQuote, Trade, Order, OrderInfo, OrderStatus } from '../model/model';
import { UserContext } from '../user';
import axios from 'axios';
import { createHash } from 'crypto';
import { parse } from 'csv-parse/sync';

/**
 * AliceBlue ANT broker implementation — real AliceBlue ANT REST API calls via axios.
 * Auth flow: getAPIEncpkey → checksum via sha256 → getUserDetails → session ID.
 * Note: Some field names are best-effort based on AliceBlue ANT API docs (they vary across versions).
 */
export default class AntBroker implements Broker {
  readonly name = 'AliceBlue ANT';
  private baseUrl = 'https://ant.aliceblueonline.com';
  private contractMasterUrl = 'https://v2api.aliceblueonline.com/restpy/static/contract_master/NFO.csv';
  private trades: Trade[] = [];
  private sessionID: string | null = null;
  private userId: string | null = null;
  private contractsCache: Map<string, string> | null = null;

  // --- session / auth ---
  getOAuthURL(): string {
    // ANT doesn't use OAuth redirects; session flow is encKey → checksum → session ID
    return '';
  }

  async requestOtp(): Promise<void> {
    // TODO: ANT's session flow doesn't use OTP
    throw new Error('[ANT] OTP login not supported; use login() with encKey flow');
  }

  async login(_otp: string): Promise<void> {
    // Treat otp param as unused (ANT uses encKey flow, not OTP)
    const userId = process.env.ALICEBLUE_USER_ID;
    const apiKey = process.env.ALICEBLUE_API_KEY;
    if (!userId || !apiKey) {
      throw new Error('[ANT] ALICEBLUE_USER_ID and ALICEBLUE_API_KEY env vars not set');
    }

    this.userId = userId;

    // Step 1: Get encKey
    const encKeyResp = await axios.post(`${this.baseUrl}/rest/AlliceBlueAPIService/api/customer/getAPIEncpkey`, { userId }, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const encKey = encKeyResp.data?.encKey;
    if (!encKey) throw new Error('[ANT] Failed to get encKey');

    // Step 2: Compute checksum
    const checksum = createHash('sha256')
      .update(userId + apiKey + encKey)
      .digest('hex');

    // Step 3: Get session ID
    const sessionResp = await axios.post(
      `${this.baseUrl}/rest/AlliceBlueAPIService/api/customer/getUserDetails`,
      {},
      {
        headers: { Authorization: `Bearer ${userId} ${checksum}` },
      }
    );

    // TODO: exact session ID field name varies across ANT API versions; this is best-effort
    this.sessionID = sessionResp.data?.sessionID || sessionResp.data?.session_id || sessionResp.data?.SesID;
    if (!this.sessionID) {
      throw new Error('[ANT] Failed to get session ID from response');
    }
  }

  async loginWithGenAcsTok(code: string): Promise<void> {
    // ANT has no separate auth-code exchange; treat as alias for the same login flow
    await this.login(code);
  }

  async logout(): Promise<void> {
    if (!this.userId || !this.sessionID) return;

    try {
      await axios.post(
        `${this.baseUrl}/rest/AlliceBlueAPIService/api/customer/logout`,
        { userId: this.userId },
        {
          headers: { Authorization: `Bearer ${this.userId} ${this.sessionID}` },
        }
      );
    } catch (e) {
      console.error('[ANT] Logout error:', e);
    }

    this.sessionID = null;
    this.userId = null;
  }

  async connect(): Promise<void> {
    // TODO: ANT's live feed is WebSocket-based (Noren-derived), out of scope for this pass
    console.log('[ANT] connect() not implemented (needs WebSocket ticker)');
  }

  async subscribeNifty(): Promise<void> {
    // TODO: needs WebSocket ticker
    console.log('[ANT] subscribeNifty() not implemented (needs WebSocket ticker)');
  }

  // --- market data ---
  private async getContractMaster(): Promise<Map<string, string>> {
    if (this.contractsCache) return this.contractsCache;

    const csv = await axios.get(this.contractMasterUrl);
    const records = parse(csv.data, { columns: true });
    const map = new Map<string, string>();
    for (const row of records) {
      // TODO: exact column names are best-effort; ANT uses various naming conventions
      const tradingsymbol = row.trading_symbol || row.TradingSymbol || row.tsym;
      const token = row.token || row.Token || row.instrument_token;
      if (tradingsymbol && token) {
        map.set(tradingsymbol, token);
      }
    }
    this.contractsCache = map;
    return map;
  }

  private async getQuoteFromAnt(exch: string, symbol: string): Promise<NiftyQuote> {
    if (!this.sessionID || !this.userId) throw new Error('[ANT] Not authenticated');

    // TODO: endpoint and field names are best-effort
    const resp = await axios.post(
      `${this.baseUrl}/rest/AlliceBlueAPIService/api/ratesModule/getQuote`,
      { exch, symbol },
      {
        headers: { Authorization: `Bearer ${this.userId} ${this.sessionID}` },
      }
    );

    const quote = new NiftyQuote();
    // TODO: exact ANT response field names vary; this is best-effort mapping
    quote.ltp = resp.data?.ltp || resp.data?.LTP || 0;
    quote.open = resp.data?.open || resp.data?.Open || 0;
    quote.high = resp.data?.high || resp.data?.High || 0;
    quote.low = resp.data?.low || resp.data?.Low || 0;
    quote.close = resp.data?.close || resp.data?.Close || 0;
    quote.prevClose = resp.data?.prevClose || resp.data?.PrevClose || quote.close;
    quote.volume = resp.data?.volume || resp.data?.Volume || 0;
    return quote;
  }

  async getQuote(index: string): Promise<NiftyQuote> {
    const indexTokens: Record<string, string> = { NIFTY: '26000', BANKNIFTY: '26009', FINNIFTY: '26037' };
    const token = indexTokens[index];
    if (!token) throw new Error(`Unknown index: ${index}`);
    return this.getQuoteFromAnt('NSE', token);
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
    return this.getQuoteFromAnt('NSE', symbol);
  }

  async getOptionQuote(token: string): Promise<NiftyQuote> {
    return this.getQuoteFromAnt('NFO', token);
  }

  async getToken(tsym: string): Promise<string> {
    const contracts = await this.getContractMaster();
    return contracts.get(tsym) || tsym;
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
    if (!this.sessionID || !this.userId) throw new Error('[ANT] Not authenticated');

    const token = await this.getToken(tsym);
    const prctyp = price > 0 ? 'L' : 'MKT';
    const transtype = action.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

    const order = {
      complexty: 'regular',
      discqty: '0',
      exch: 'NFO',
      pCode: 'MIS',
      prctyp,
      price: String(price),
      qty: String(quantity),
      ret: 'DAY',
      symbol_id: token,
      trading_symbol: tsym,
      transtype,
      trigPrice: '0',
    };

    // ANT expects an array of orders (multi-leg shape)
    await axios.post(
      `${this.baseUrl}/rest/AlliceBlueAPIService/api/placeOrder/executePlaceOrder`,
      [order],
      {
        headers: { Authorization: `Bearer ${this.userId} ${this.sessionID}` },
      }
    );

    return {
      token,
      contract: tsym,
      qty: quantity,
      price,
      lastOrderedPrice: price,
      status: OrderStatus.ORDERED,
    };
  }

  async squareOffOrder(token: string, qty: number, _user?: string, price?: number): Promise<void> {
    const tsym = token;
    const prctyp = price ? 'L' : 'MKT';

    const order = {
      complexty: 'regular',
      discqty: '0',
      exch: 'NFO',
      pCode: 'MIS',
      prctyp,
      price: String(price || 0),
      qty: String(qty),
      ret: 'DAY',
      symbol_id: token,
      trading_symbol: tsym,
      transtype: 'SELL',
      trigPrice: '0',
    };

    await axios.post(
      `${this.baseUrl}/rest/AlliceBlueAPIService/api/placeOrder/executePlaceOrder`,
      [order],
      {
        headers: { Authorization: `Bearer ${this.userId} ${this.sessionID}` },
      }
    );
  }

  async getOrders(): Promise<Order[]> {
    if (!this.sessionID || !this.userId) throw new Error('[ANT] Not authenticated');

    // TODO: exact endpoint and field names are best-effort
    const resp = await axios.post(
      `${this.baseUrl}/rest/AlliceBlueAPIService/api/placeOrder/fetchOrderBook`,
      {},
      {
        headers: { Authorization: `Bearer ${this.userId} ${this.sessionID}` },
      }
    );

    const orders = Array.isArray(resp.data) ? resp.data : resp.data?.orders || [];
    return orders
      .filter((o: any) => o.Status && o.Status.toUpperCase() !== 'COMPLETE')
      .map((o: any) => ({
        orderno: o.Nstordno || o.order_id || '',
        tsym: o.Trsym || o.tradingsymbol || '',
        trantype: o.Trantype || o.transaction_type || '',
        quantity: parseInt(o.Qty || o.quantity || '0'),
        price: parseFloat(o.Prc || o.price || '0'),
        token: o.Symbol_id || o.token || '',
      } as Order));
  }

  getTradeList(): Trade[] {
    return this.trades;
  }

  async refreshTradeList(): Promise<Trade[]> {
    if (!this.sessionID || !this.userId) throw new Error('[ANT] Not authenticated');

    // TODO: exact endpoint and field names are best-effort
    const resp = await axios.post(
      `${this.baseUrl}/rest/AlliceBlueAPIService/api/positionAndHoldings/positionBook`,
      {},
      {
        headers: { Authorization: `Bearer ${this.userId} ${this.sessionID}` },
      }
    );

    const positions = Array.isArray(resp.data) ? resp.data : resp.data?.positions || [];
    this.trades = positions
      .filter((p: any) => parseInt(p.Netqty || p.quantity || '0') > 0)
      .map((p: any) => ({
        tsym: p.Tsym || p.tradingsymbol || '',
        token: p.Token || p.instrument_token || '',
        stockCode: (p.Tsym || '').split(/\d+/)[0] || '',
        expiryDate: '',
        strikePrice: '',
        right: 'call',
        action: 'Buy',
        quantity: parseInt(p.Netqty || p.quantity || '0'),
        flqty: parseInt(p.Netqty || p.quantity || '0'),
        price: parseFloat(p.BuyAvgPrice || p.average_price || '0'),
        ltp: parseFloat(p.LTP || p.last_price || '0'),
        strategy: 'manual',
        isPendingOrder: false,
        isBuyPending: false,
        isSellPending: false,
        lastTradePrice: parseFloat(p.LTP || p.last_price || '0'),
        status: 'OPEN',
        targetPrice: 0,
        stopLossPrice: 0,
        targetPoints: 0,
        trailingDistance: 0,
        highWaterMark: parseFloat(p.LTP || p.last_price || '0'),
        trailingActive: false,
        user: 'Default',
        open: true,
        realizedPnL: 0,
      } as Trade));
    return this.trades;
  }
}
