import net from 'net';
import fs from 'fs';
import Log from '../../util/Log';
import { writeJsonLine, readJsonLines } from '../../ipc/jsonLines';
import { ownSocketTracker } from '../../ipc/ownSocket';
import { DATA_SOCKET_PATH, DataCommand } from '../../ipc/dataProtocol';
import { DEFAULT_FEED_SOURCE } from '../../ipc/feedSource';

// Past this many unsent bytes a client is not keeping up: its ticks are dropped (and said so) instead of growing `data`'s memory.
const MAX_CLIENT_BACKLOG_BYTES = 32 * 1024 * 1024;

type SubKind = 'subscribe' | 'subscribeDepth';

// The `data` process's socket server. Ticks go to every client. Subscriptions are reference-counted per feed token across clients:
// `onFirstSubscribe` runs when the first client takes a token and `onLastUnsubscribe` when the last one lets go (explicitly, or by
// disconnecting), so one client's unsubscribe can never cut off a token another still depends on.
export class DataServer {
    private clients = new Set<net.Socket>();
    // `${kind}|${source}|${token}|${exchange}` -> who holds it, and the arguments the first subscribe used (the release repeats them).
    private holds = new Map<string, { holders: Set<net.Socket>; kind: SubKind; token: string; source?: string; exchange?: 'NFO' | 'BFO' }>();
    private ownSocket = ownSocketTracker();
    private lastDropWarnAt = 0;
    private server: net.Server | null = null;

    constructor(
        private readonly handlers: {
            subscribe(kind: SubKind, token: string, source: string | undefined, exchange: 'NFO' | 'BFO' | undefined): void;
            unsubscribe(kind: SubKind, token: string, source: string | undefined, exchange: 'NFO' | 'BFO' | undefined): void;
            other(cmd: DataCommand): void;
        },
        private readonly socketPath: string = DATA_SOCKET_PATH,
    ) {}

    start(): void {
        if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
        this.server = net.createServer((socket) => {
            this.clients.add(socket);
            Log.log('[data] Client connected, total:', this.clients.size);
            readJsonLines(
                socket,
                (cmd) => this.onCommand(socket, cmd as DataCommand),
                (line, err) => Log.log('[data] Failed to parse client command:', line, err),
            );
            socket.on('close', () => {
                this.clients.delete(socket);
                this.releaseAll(socket);
                Log.log('[data] Client disconnected, total:', this.clients.size);
            });
            socket.on('error', (e) => Log.log('[data] Client socket error:', e));
        });
        this.server.listen(this.socketPath, () => {
            this.ownSocket.record(this.socketPath);
            Log.log('[data] Listening on', this.socketPath);
        });
    }

    stop(): void {
        this.server?.close();
        for (const c of this.clients) c.destroy(); // clients must see the close (a lingering connection would hide the outage)
        this.ownSocket.unlink(this.socketPath);
    }

    broadcast(tick: unknown): void {
        for (const c of this.clients) {
            if (c.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
                const now = Date.now();
                if (now - this.lastDropWarnAt > 10_000) {
                    this.lastDropWarnAt = now;
                    Log.log(`[data] ALERT: a client is ${Math.round(c.writableLength / 1048576)} MB behind - dropping its ticks`);
                }
                continue;
            }
            writeJsonLine(c, tick);
        }
    }

    clientCount(): number {
        return this.clients.size;
    }

    private keyOf(kind: SubKind, cmd: { token: string; source?: string; exchange?: string }): string {
        // Omitted source / exchange mean the defaults ('ant' / 'NFO'), so the same token is one hold however a client spells it.
        return `${kind}|${cmd.source ?? DEFAULT_FEED_SOURCE}|${cmd.token}|${cmd.exchange ?? 'NFO'}`;
    }

    private onCommand(socket: net.Socket, cmd: DataCommand): void {
        if (cmd.cmd === 'subscribe' || cmd.cmd === 'subscribeDepth') {
            if (!cmd.token) return;
            const key = this.keyOf(cmd.cmd, cmd);
            let hold = this.holds.get(key);
            if (!hold) {
                hold = { holders: new Set(), kind: cmd.cmd, token: cmd.token, source: cmd.source, exchange: cmd.exchange };
                this.holds.set(key, hold);
            }
            const first = hold.holders.size === 0;
            hold.holders.add(socket);
            if (first) this.handlers.subscribe(cmd.cmd, cmd.token, cmd.source, cmd.exchange);
        } else if (cmd.cmd === 'unsubscribe' || cmd.cmd === 'unsubscribeDepth') {
            if (!cmd.token) return;
            const kind: SubKind = cmd.cmd === 'unsubscribe' ? 'subscribe' : 'subscribeDepth';
            this.release(socket, this.keyOf(kind, cmd));
        } else {
            this.handlers.other(cmd);
        }
    }

    private release(socket: net.Socket, key: string): void {
        const hold = this.holds.get(key);
        if (!hold || !hold.holders.delete(socket)) return;
        if (hold.holders.size === 0) {
            this.holds.delete(key);
            this.handlers.unsubscribe(hold.kind, hold.token, hold.source, hold.exchange);
        }
    }

    // A closed connection gives up everything it held. (`trading` replays its subscriptions on reconnect.)
    private releaseAll(socket: net.Socket): void {
        for (const [key, hold] of Array.from(this.holds.entries())) {
            if (hold.holders.has(socket)) this.release(socket, key);
        }
    }
}
