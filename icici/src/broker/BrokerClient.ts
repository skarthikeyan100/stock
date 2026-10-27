import { BrokerName } from '../util/brokerName';

// The session/read surface every broker's client singleton (Kite, ANT, Breeze, Prism) offers, behind one interface so
// server.ts (login, callback, debug reads) and the executors do not branch on the broker name. Order placement is NOT here:
// that lives in the order process's BrokerExecutor (src/processes/order/BrokerExecutor.ts), which needs bookkeeping state this
// interface (and the `frontend` process using it) must not pull in.

// Thrown by exchangeToken when the broker's redirect did not carry what the exchange needs; the caller answers 400.
export class MissingCredentialsError extends Error {}

// What a login redirect can carry, by the names the brokers use (only the ones a broker needs are read).
export interface CallbackParams {
    code?: string;          // Prism/Shoonya
    authCode?: string;      // ANT (with userId)
    userId?: string;        // ANT
    requestToken?: string;  // Kite
    apiSession?: string;    // Breeze
}

export interface BrokerClient {
    readonly name: BrokerName;
    readonly label: string;
    hasValidSession(): Promise<boolean>;
    getLoginUrl(): string;
    // Exchanges the redirect's credentials for a stored session. Throws MissingCredentialsError when they are absent.
    exchangeToken(params: CallbackParams): Promise<void>;
    // `exchange` is needed by brokers whose cancel API takes it (Breeze); the others ignore it.
    cancelOrder(orderId: string, exchange?: string): Promise<void>;
    getTrades(): Promise<any[]>;
    getPositions(): Promise<any[]>;
}
