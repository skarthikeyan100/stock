// Message shapes for the strategies<->frontend Unix-domain-socket channel.
// `strategies` is the server here too (like `order`) - `frontend` connects as a
// client with the same reconnect-on-drop tolerance, since `strategies` is the
// process most likely to be killed/respawned during dev.

export const STRATEGIES_SOCKET_PATH = process.env.STRATEGIES_IPC_SOCKET || '/tmp/icici-strategies.sock';

export type StrategiesRequestType = 'stats' | 'list' | 'setEnabled' | 'reset' | 'getCandles';

export interface StrategiesRequest {
    kind: 'request';
    id: string;
    type: StrategiesRequestType;
    payload: any;
}

export interface StrategiesResponse {
    kind: 'response';
    id: string;
    ok: boolean;
    result?: any;
    error?: string;
}
