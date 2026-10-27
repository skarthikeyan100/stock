import Kite from '../kite/Kite';
import ANT from '../ant/ANT';
import Breeze from '../breeze/Breeze';
import Prism from '../prism';
import Log from '../util/Log';
import { BrokerName, normalizeBrokerName } from '../util/brokerName';
import { BrokerClient, MissingCredentialsError } from './BrokerClient';

// Wraps the four client singletons behind BrokerClient. Thin: each method is the singleton's own call.
export const BROKER_CLIENTS: Record<BrokerName, BrokerClient> = {
    prism: {
        label: 'Shoonya',
        getLoginUrl: () => Prism.getInstance().getOAuthURL(),
        exchangeToken: async ({ code }) => {
            if (!code) throw new MissingCredentialsError('No authorization code received');
            Log.log('Authorization code received, exchanging for token');
            await Prism.getInstance().loginWithGenAcsTok(code);
        },
        getTrades: async () => Prism.getInstance().getTradeList(),
        getPositions: async () => Prism.getInstance().getPositions(),
    },
    ant: {
        label: 'ANT',
        getLoginUrl: () => ANT.getInstance().getAuthorizationUrl(),
        exchangeToken: async ({ authCode, userId }) => {
            if (!authCode || !userId) throw new MissingCredentialsError('Missing authCode or userId from Alice Blue');
            Log.log('ANT Callback received - exchanging authCode for token');
            // (No ant_session cookie: the broker token lives server-side only; nothing reads a browser copy.)
            await ANT.getInstance().exchangeAuthCodeForToken(userId, authCode);
        },
        getTrades: () => ANT.getInstance().getTrades(),
        getPositions: () => ANT.getInstance().getPositions(),
    },
    kite: {
        label: 'Kite',
        getLoginUrl: () => Kite.getInstance().getLoginURL(),
        exchangeToken: async ({ requestToken }) => {
            if (!requestToken) throw new MissingCredentialsError('Missing request_token from Kite');
            Log.log('Kite Callback received - exchanging request_token for access_token');
            await Kite.getInstance().exchangeRequestTokenForSession(requestToken); // broker token stays server-side only - no cookie copy
        },
        getTrades: () => Kite.getInstance().getTrades(),
        getPositions: () => Kite.getInstance().getPositions(),
    },
    breeze: {
        label: 'Breeze',
        getLoginUrl: () => Breeze.getInstance().getLoginURL(),
        exchangeToken: async ({ apiSession }) => {
            if (!apiSession) throw new MissingCredentialsError('Missing API_Session from ICICI Breeze');
            Log.log('Breeze Callback received - generating session');
            await Breeze.getInstance().generateSession(apiSession);
        },
        getTrades: async () => {
            const toDate = new Date();
            const fromDate = new Date(toDate);
            fromDate.setDate(fromDate.getDate() - 7);
            const result = await Breeze.getInstance().getTradeList({ fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), exchangeCode: 'NFO' });
            return Array.isArray(result?.Success) ? result.Success : [];
        },
        getPositions: async () => {
            const result = await Breeze.getInstance().getPortfolioPositions();
            return Array.isArray(result?.Success) ? result.Success : [];
        },
    },
};

// The client for a broker name (aliases accepted); undefined for anything that is not a broker.
export function brokerClientFor(name: unknown): BrokerClient | undefined {
    const n = normalizeBrokerName(name);
    return Object.prototype.hasOwnProperty.call(BROKER_CLIENTS, n) ? BROKER_CLIENTS[n as BrokerName] : undefined;
}
