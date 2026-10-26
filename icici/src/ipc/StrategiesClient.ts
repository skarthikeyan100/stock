import net from 'net';
import Log from '../util/Log';
import { writeJsonLine, readJsonLines } from './jsonLines';
import { STRATEGIES_SOCKET_PATH, StrategiesRequest, StrategiesRequestType, StrategiesResponse } from './strategiesProtocol';

// frontend's (and only frontend's) path to live strategy state. Same
// reconnect-on-drop pattern as OrderClient (src/processes/strategies/OrderClient.ts)
// since `strategies` is the process most likely to restart during dev.

class StrategiesClient {
    private static instance: StrategiesClient;
    private socket: net.Socket | null = null;
    private pending: Map<string, { resolve: (r: StrategiesResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = new Map();
    private nextId = 0;

    static getInstance(): StrategiesClient {
        if (!StrategiesClient.instance) StrategiesClient.instance = new StrategiesClient();
        return StrategiesClient.instance;
    }

    connect(): void {
        this.socket = net.createConnection(STRATEGIES_SOCKET_PATH);
        this.socket.on('connect', () => Log.log('[frontend] Connected to strategies process'));

        readJsonLines(
            this.socket,
            (msg) => {
                if (msg.kind === 'response') {
                    const waiter = this.pending.get(msg.id);
                    if (waiter) {
                        this.pending.delete(msg.id);
                        clearTimeout(waiter.timer);
                        waiter.resolve(msg as StrategiesResponse);
                    }
                }
            },
            (line, err) => Log.log('[frontend] Failed to parse strategies-process message:', line, err)
        );

        this.socket.on('close', () => {
            Log.log('[frontend] Disconnected from strategies process, retrying in 2s...');
            // Fail in-flight requests now; their responses can never arrive on a closed socket.
            for (const [id, w] of this.pending) { clearTimeout(w.timer); w.reject(new Error('Strategies process connection closed')); this.pending.delete(id); }
            setTimeout(() => this.connect(), 2000);
        });
        this.socket.on('error', (e) => Log.log('[frontend] Strategies socket error:', e));
    }

    private request(type: StrategiesRequestType, payload: any): Promise<StrategiesResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket) return reject(new Error('Not connected to strategies process'));
            const id = String(this.nextId++);
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Strategies request '${type}' timed out`)); }, 30000);
            this.pending.set(id, { resolve, reject, timer });
            const req: StrategiesRequest = { kind: 'request', id, type, payload };
            writeJsonLine(this.socket, req);
        });
    }

    async stats(): Promise<any[]> {
        const res = await this.request('stats', {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async list(): Promise<any[]> {
        const res = await this.request('list', {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async setEnabled(identifier: string, enabled: boolean): Promise<any[]> {
        const res = await this.request('setEnabled', { identifier, enabled });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async reset(type: string): Promise<{ type: string; reset: number }> {
        const res = await this.request('reset', { type });
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async getCandles(): Promise<any[]> {
        const res = await this.request('getCandles', {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }

    async subscribeToken(token: string): Promise<void> {
        const res = await this.request('subscribeToken', { token });
        if (!res.ok) throw new Error(res.error);
    }

    async unsubscribeToken(token: string): Promise<void> {
        const res = await this.request('unsubscribeToken', { token });
        if (!res.ok) throw new Error(res.error);
    }

    async syncFromConfig(): Promise<void> {
        const res = await this.request('syncFromConfig', {});
        if (!res.ok) throw new Error(res.error);
    }

    // On-demand reconcile (POST /reconcile) - only after `order`'s broker reconcile.
    async reconcile(): Promise<{ ran: boolean }> {
        const res = await this.request('reconcile', {});
        if (!res.ok) throw new Error(res.error);
        return res.result;
    }
}

export default StrategiesClient;
