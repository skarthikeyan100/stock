declare module 'kiteconnect' {
  export type Exchanges = 'NSE' | 'BSE' | 'NFO' | 'MCX' | 'BFO';
  export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  export type TransactionType = 'BUY' | 'SELL';
  export type Product = 'NRML' | 'CNC' | 'MIS' | 'BO';
  export type TriggerType = 'regular' | 'two-leg' | 'one-cancels-other' | 'bracket';

  export interface Instrument {
    instrument_token: number;
    exchange_token: number;
    tradingsymbol: string;
    name: string;
    last_price: number;
    tick_size: number;
    expiry: Date;
    strike: number;
    lot_size: number;
    instrument_type: string;
    segment: string;
    exchange: Exchanges;
  }

  export interface Order {
    order_id: string;
    instrument_token: number;
    tradingsymbol: string;
    transaction_type: TransactionType;
    quantity: number;
    price: number;
    status: string;
    average_price?: number;
  }

  export interface Position {
    instrument_token: number;
    tradingsymbol: string;
    exchange: Exchanges;
    quantity: number;
    average_price: number;
    last_price: number;
  }

  export interface Margin {
    equity: {
      enabled: boolean;
      net: number;
      available: number;
      used: number;
      utilised: number;
    };
  }

  export interface Profile {
    user_id: string;
    email: string;
    username: string;
    phone: string;
    status: string;
  }

  export type Connect = KiteConnect;

  export class KiteConnect {
    constructor(options: { api_key: string });

    getLoginURL(): string;
    generateSession(requestToken: string, apiSecret: string): Promise<{ access_token: string; user_id: string }>;
    setAccessToken(token: string): void;
    invalidateAccessToken(): Promise<void>;

    getProfile(): Promise<Profile>;
    getMargins(): Promise<Margin>;
    getInstruments(exchange?: Exchanges): Promise<Instrument[]>;
    getLTP(symbols: string[]): Promise<Record<string, any>>;
    getQuote(symbols: string[]): Promise<Record<string, any>>;

    getOrders(): Promise<Order[]>;
    getOrderHistory(orderId: string): Promise<any[]>;
    placeOrder(variety: string, params: any): Promise<{ order_id: string }>;
    modifyOrder(orderId: string, variety: string, params: any): Promise<any>;
    cancelOrder(orderId: string, variety: string): Promise<any>;

    getPositions(): Promise<{ net: Position[]; day: Position[] }>;
    getHoldings(): Promise<any[]>;

    placeGTT(params: any): Promise<{ trigger_id: number }>;
  }
}
