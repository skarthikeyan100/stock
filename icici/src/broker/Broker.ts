import { NiftyQuote, Trade, Order, OrderInfo } from '../model/model';
import { UserContext } from '../user';

export type OrderRight = 'call' | 'put';
export type OrderAction = 'buy' | 'sell';

/**
 * Common broker interface — abstracts the various broker APIs (Shoonya, Zerodha, AliceBlue ANT, etc.)
 * into a unified contract. Each broker implementation handles its own auth, quote fetching, and order routing.
 *
 * Note: `UserContext` is a type-only import and carries no runtime wiring into the live app.
 * Note: `getTradeList()` is synchronous and returns a locally-cached array. Implementations should
 * populate this cache via `refreshTradeList()` since standalone broker classes have no `Monitor` singleton.
 * Note: `buyContract` returns `Promise<OrderInfo>` (Prism's signature returns `any`, but the real shape is `OrderInfo`).
 */
export interface Broker {
  readonly name: string;

  // --- session / auth ---
  connect(): Promise<void>;
  getOAuthURL(): string;
  requestOtp(): Promise<void>;
  login(otp: string): Promise<void>;
  loginWithGenAcsTok(code: string): Promise<void>;
  logout(): Promise<void>;

  // --- market data ---
  getQuote(index: string): Promise<NiftyQuote>;
  getNiftyQuote(): Promise<NiftyQuote>;
  getBankNiftyQuote(): Promise<NiftyQuote>;
  getFinNiftyQuote(): Promise<NiftyQuote>;
  getStockQuote(symbol: string): Promise<NiftyQuote>;
  getOptionQuote(token: string): Promise<NiftyQuote>;
  subscribeNifty(): Promise<void>;
  getToken(tsym: string): Promise<string>;

  // --- orders ---
  buyContract(contract: string, qty?: number, price?: number, userContext?: UserContext): Promise<OrderInfo>;
  buyOrder(symbol: string, qty: number, price: number, userContext?: UserContext): Promise<OrderInfo>;
  sellOrder(symbol: string, qty: number, price: number, userContext?: UserContext): Promise<OrderInfo>;
  sendLimitOrder(tsym: string, price: number, right: OrderRight, action: OrderAction, quantity: number, userContext?: UserContext): Promise<OrderInfo>;
  squareOffOrder(token: string, qty: number, user?: string, price?: number): Promise<void>;
  getOrders(): Promise<Order[]>;
  getTradeList(): Trade[];
  refreshTradeList(): Promise<Trade[]>;
}
