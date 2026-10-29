import net from 'net';
import Log from '../util/Log';
import { readJsonLines, writeJsonLine } from './jsonLines';
import { DATA_SOCKET_PATH, DataCommand } from './dataProtocol';
import { DEFAULT_FEED_SOURCE } from './feedSource';

// A process's connection to the `data` process: ticks in, feed commands out. Reconnects on drop and, on every (re)connect, replays the
// subscriptions currently held - so a restarted `data` (or a dropped socket) needs no resync step from the consumers.
//
// Subscriptions are reference-counted per feed token across the OWNERS inside this process (strategy router, exit monitor, ...): the
// command that cancels a token goes to `data` only when the last owner lets go.
type Tick = any;
type TickHandler = (tick: Tick) => void;
type StatusHandler = (up: boolean) => void;

const RETRY_MS = 2000;

export class DataLink {
    private static instance: DataLink;
    static getInstance(): DataLink {
        if (!DataLink.instance) DataLink.instance = new DataLink();
        return DataLink.instance;
    }

    private socket: net.Socket | null = null;
    private up = false;
    private started = false;
    private tickHandlers: TickHandler[] = [];
    private statusHandlers: StatusHandler[] = [];
    private active = new Map<string, { cmd: DataCommand; owners: Set<string> }>();

    constructor(private readonly socketPath: string = DATA_SOCKET_PATH) {}

    onTick(handler: TickHandler): void { this.tickHandlers.push(handler); }
    onStatus(handler: StatusHandler): void { this.statusHandlers.push(handler); }
    isUp(): boolean { return this.up; }

    // Idempotent: every entry point of a process may call it.
    connect(): void {
        if (this.started) return;
        this.started = true;
        this.open();
    }

    private open(): void {
        const socket = net.createConnection(this.socketPath);
        this.socket = socket;
        socket.on('connect', () => {
            this.up = true;
            Log.log('[data-link] Connected to the data process');
            for (const { cmd } of this.active.values()) writeJsonLine(socket, cmd); // replay what this process holds
            for (const h of this.statusHandlers) h(true);
        });
        readJsonLines(
            socket,
            (tick) => { for (const h of this.tickHandlers) h(tick); },
            (line, err) => { if (line) Log.log('[data-link] Failed to parse a tick:', line, err); },
        );
        socket.on('error', () => { /* 'close' follows and retries */ });
        socket.on('close', () => {
            const wasUp = this.up;
            this.up = false;
            this.socket = null;
            if (wasUp) {
                Log.log(`[data-link] ALERT: lost the data process - no ticks until it is back; retrying every ${RETRY_MS / 1000}s`);
                for (const h of this.statusHandlers) h(false);
            }
            setTimeout(() => this.open(), RETRY_MS);
        });
    }

    private keyOf(cmd: { cmd: string; token?: string; source?: string; exchange?: string }): string {
        const kind = cmd.cmd === 'unsubscribe' ? 'subscribe' : cmd.cmd === 'unsubscribeDepth' ? 'subscribeDepth' : cmd.cmd;
        // Omitted source / exchange mean the defaults ('ant' / 'NFO'), so the same token is one key however a caller spells it.
        return `${kind}|${cmd.source ?? DEFAULT_FEED_SOURCE}|${cmd.token}|${cmd.exchange ?? 'NFO'}`;
    }

    private write(cmd: DataCommand): void {
        if (this.socket && this.up) writeJsonLine(this.socket, cmd);
    }

    // `owner` names the in-process subsystem making the request ('strategies', 'exit', ...).
    subscribe(owner: string, cmd: Extract<DataCommand, { token: string }>): void {
        if (cmd.cmd === 'unsubscribe' || cmd.cmd === 'unsubscribeDepth') {
            const key = this.keyOf(cmd);
            const entry = this.active.get(key);
            if (!entry || !entry.owners.delete(owner)) return;
            if (entry.owners.size === 0) {
                this.active.delete(key);
                this.write(cmd);
            }
            return;
        }
        const key = this.keyOf(cmd);
        const entry = this.active.get(key);
        if (entry) { entry.owners.add(owner); return; }
        this.active.set(key, { cmd, owners: new Set([owner]) });
        this.write(cmd);
    }

    // A one-shot command with no state to replay (e.g. 'reconnect' after a broker login). Dropped, and said so, while `data` is down.
    send(cmd: DataCommand): void {
        if (!this.up) {
            Log.log(`[data-link] ${cmd.cmd} not sent - the data process is not connected`);
            return;
        }
        this.write(cmd);
    }
}
