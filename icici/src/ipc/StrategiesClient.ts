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
    private connected = false;
    // A config sync that could not be delivered (strategies down / mid-restart) is replayed when the connection returns,
    // otherwise a config save made during a strategies hot restart would be silently lost.
    private needsSync = false;

    static getInstance(): StrategiesClient {
        if (!StrategiesClient.instance) StrategiesClient.instance = new StrategiesClient();
        return StrategiesClient.instance;
    }

    connect(): void {
        const sock = net.createConnection(STRATEGIES_SOCKET_PATH);
        this.socket = sock;
        sock.on('connect', () => {
            this.connected = true;
            Log.log('[frontend] Connected to strategies process');
            if (this.needsSync) {
                this.needsSync = false;
                this.syncFromConfig().catch((e) => Log.log('[frontend] replayed syncFromConfig failed:', e));
            }
        });

        readJsonLines(
            sock,
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

        sock.on('close', () => {
            Log.log('[frontend] Disconnected from strategies process, retrying in 2s...');
            // Mark disconnected NOW so requests during the 2s gap fail fast ('Not connected') instead of hanging to the
            // 30s timeout on a dead socket; drop the old socket's listeners before a new one is created.
            if (this.socket === sock) { this.socket = null; this.connected = false; }
            sock.removeAllListeners();
            sock.on('error', () => undefined);
            // Fail in-flight requests now; their responses can never arrive on a closed socket.
            for (const [id, w] of this.pending) { clearTimeout(w.timer); w.reject(new Error('Strategies process connection closed')); this.pending.delete(id); }
            setTimeout(() => this.connect(), 2000);
        });
        sock.on('error', (e) => Log.log('[frontend] Strategies socket error:', e));
    }

    private request(type: StrategiesRequestType, payload: any): Promise<StrategiesResponse> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) return reject(new Error('Not connected to strategies process'));
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

    async reset(type: string): Promise<{ type: string; reset: number }> {
        const res = await this.request('reset', { type });
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
        let res: StrategiesResponse;
        try {
            res = await this.request('syncFromConfig', {});
        } catch (e) {
            this.needsSync = true;
            throw e;
        }
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
