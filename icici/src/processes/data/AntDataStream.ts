import Log from '../../util/Log';
import { isPastMarketClose } from '../../util/marketHours';
import AntSession from '../../ant/AntSession';
import AntWebSocket from '../../ant/AntWebSocket';
import ANT from '../../ant/ANT';
import Mongo from '../../tools/mongo';
import configService from '../../prism/ConfigService';
import { NiftyQuote, OptionQuote, SensexQuote } from '../../model/model';
import { DataStream } from './DataStream';

// data process's own tick source. Adapted from src/ant/AntStream.ts: same ANT
// session/websocket plumbing, but ticks go to stdout (writeTick) instead of
// Monitor/Decision/myEmitter - this process has no dependency on any of those.
class AntDataStream implements DataStream {
    private static instance: AntDataStream;
    private ws: AntWebSocket | null = null;
    private connected = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectDelayMs = 2000;
    private readonly MAX_RECONNECT_DELAY_MS = 30000;
    private manualDisconnect = false;
    private connecting: Promise<void> | null = null;

    private readonly INDEX_TOKEN = '26000'; // NIFTY
    private readonly SENSEX_TOKEN = '1';
    private readonly ALWAYS_ON = [
        { exch: 'NSE', token: '26000' },
        { exch: 'BSE', token: '1' },
    ];

    // Maps bare token -> its exchange ('NFO'/'BFO'), not a Set<string> -
    // the reconnect resubscribe below (and unsubscribe) must rebuild the
    // same `${exchange}|${token}` key a BFO (SENSEX) token was originally
    // subscribed with, not always assume NFO (found on code review).
    private dynamicOptionTokens: Map<string, 'NFO' | 'BFO'> = new Map();
    // Depth-mode subscriptions - a separate AliceBlue subscription type from
    // dynamicOptionTokens' touchline above, used only for the momentum
    // signal's tbq/tsq (see MomentumSignal.ts). A token can be in both maps
    // independently (e.g. an open leg's touchline token happening to also be
    // momentum-checked).
    private dynamicDepthTokens: Map<string, 'NFO' | 'BFO'> = new Map();

    constructor(private writeTick: (tick: any) => void) {}

    static getInstance(writeTick: (tick: any) => void): AntDataStream {
        if (!AntDataStream.instance) {
            AntDataStream.instance = new AntDataStream(writeTick);
        }
        return AntDataStream.instance;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            Log.log('[AntDataStream] Already connected');
            return;
        }
        // In-flight guard: concurrent callers share one attempt.
        if (this.connecting) return this.connecting;
        this.connecting = this.doConnect().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    private async doConnect(): Promise<void> {
        this.manualDisconnect = false;
        Log.log('[AntDataStream] Connecting to ANT streaming...');
        const session = AntSession.getInstance();
        const sessionId = await session.getSessionId();
        await session.prepareWsSession(sessionId);
        const susertoken = session.getSusertoken(sessionId);
        const ant = ANT.getInstance();
        const userId = ant.getUserId();
        if (!userId) throw new Error('userId not available');

        // Drop any previous socket first so its late 'close' cannot schedule a duplicate reconnect.
        if (this.ws) {
            const old = this.ws;
            this.ws = null;
            try { old.close(); } catch (e) { /* already closed */ }
        }

        const ws = new AntWebSocket();
        // Handlers are bound to THIS socket; events from a superseded socket are ignored.
        ws.on('open', () => {
            if (this.ws !== ws) return;
            Log.log('[AntDataStream] WebSocket open, subscribing to always-on instruments...');
            const fixedKeys = this.ALWAYS_ON.map((i) => `${i.exch}|${i.token}`);
            const dynamicKeys = Array.from(this.dynamicOptionTokens, ([t, exch]) => `${exch}|${t}`);
            ws.subscribe([...fixedKeys, ...dynamicKeys]);
            if (this.dynamicDepthTokens.size > 0) {
                ws.subscribeDepth(Array.from(this.dynamicDepthTokens, ([t, exch]) => `${exch}|${t}`));
            }
        });

        ws.on('quote', (_event, data) => {
            if (this.ws !== ws) return;
            this.persistQuote(data);
            this.emitTick(data);
        });

        ws.on('error', (_event, error) => {
            Log.log('[AntDataStream] WebSocket error:', error);
        });

        ws.on('close', () => {
            if (this.ws !== ws) return; // superseded/manually closed socket
            Log.log('[AntDataStream] WebSocket closed');
            this.ws = null;
            this.connected = false;
            if (this.manualDisconnect) return;
            if (isPastMarketClose()) {
                Log.log('[AntDataStream] Past market close - not reconnecting');
                return;
            }
            this.scheduleReconnect();
        });

        this.ws = ws;
        try {
            await ws.connect({ susertoken, actid: userId + '_API', uid: userId + '_API' });
        } catch (e) {
            if (this.ws === ws) this.ws = null;
            try { ws.close(); } catch (_) { /* ignore */ }
            throw e;
        }
        if (this.ws !== ws) return; // disconnect() raced the connect

        this.connected = true;
        this.reconnectDelayMs = 2000; // reset backoff on a successful connect
        Log.log('[AntDataStream] Connected and streaming');
    }

    // Auto-reconnect with exponential backoff - previously a dropped websocket
    // just sat there until someone manually hit /ant/connect. Manual reconnect
    // (the 'reconnect' stdin command, for /ant/connect parity) still works via
    // reconnect() below.
    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        Log.log(`[AntDataStream] Reconnecting in ${this.reconnectDelayMs}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((e) => {
                Log.log('[AntDataStream] Reconnect attempt failed:', e);
                if (isPastMarketClose()) {
                    Log.log('[AntDataStream] Past market close - not retrying');
                    return;
                }
                this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.MAX_RECONNECT_DELAY_MS);
                this.scheduleReconnect();
            });
        }, this.reconnectDelayMs);
    }

    // Forces a fresh connection even if one is already considered active -
    // mirrors the old /ant/connect route's semantics (idempotent-ish manual trigger).
    async reconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.connecting) {
            try { await this.connecting; } catch (e) { /* retry below */ }
        }
        this.disconnect();
        this.manualDisconnect = false;
        await this.connect();
    }

    private emitTick(data: any): void {
        // Depth feed updates ('df') are sparse - a tick carrying a fresh
        // tbq/tsq for a depth-tracked token doesn't always also carry 'lp',
        // so the usual "no lp, nothing new" short-circuit would silently
        // drop it. Relax the guard only for tokens actually depth-tracked.
        const isDepthTracked = this.dynamicDepthTokens.has(data.tk);
        if (!data.lp && !(isDepthTracked && (data.tbq !== undefined || data.tsq !== undefined))) return;
        try {
            if (data.tk === this.INDEX_TOKEN) {
                this.writeTick({ type: 'nifty', quote: NiftyQuote.fromAnt(data) });
            } else if (data.tk === this.SENSEX_TOKEN) {
                this.writeTick({ type: 'sensex', quote: SensexQuote.fromAnt(data) });
            } else if (this.dynamicOptionTokens.has(data.tk) || isDepthTracked) {
                this.writeTick({ type: 'option', quote: OptionQuote.fromAnt(data) });
            }
        } catch (e) {
            Log.log('[AntDataStream] emitTick failed:', e);
        }
    }

    private persistQuote(data: any): void {
        if (!data.lp || !configService.getConfig().settings?.logQuotes) return;
        try {
            if (data.tk === this.INDEX_TOKEN) {
                Mongo.getInstance()?.tryInsert(NiftyQuote.fromAnt(data));
            } else if (data.tk === this.SENSEX_TOKEN) {
                Mongo.getInstance()?.tryInsert(SensexQuote.fromAnt(data));
            } else if (this.dynamicOptionTokens.has(data.tk) || this.dynamicDepthTokens.has(data.tk)) {
                Mongo.getInstance()?.tryInsert(OptionQuote.fromAnt(data));
            }
        } catch (e) {
            Log.log('[AntDataStream] Mongo insert failed:', e);
        }
    }

    async subscribeOption(token: string, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<void> {
        if (this.dynamicOptionTokens.has(token)) return;
        this.dynamicOptionTokens.set(token, exchange);
        this.ws?.subscribe([`${exchange}|${token}`]);
    }

    async unsubscribeOption(token: string, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<void> {
        if (!this.dynamicOptionTokens.has(token)) return;
        // Unsubscribe with the exchange it was actually subscribed under, not
        // whatever the caller passes this time - defensive, in case a caller
        // ever gets that wrong.
        const actualExchange = this.dynamicOptionTokens.get(token)!;
        this.dynamicOptionTokens.delete(token);
        this.ws?.unsubscribe([`${actualExchange}|${token}`]);
    }

    async subscribeOptionDepth(token: string, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<void> {
        if (this.dynamicDepthTokens.has(token)) return;
        this.dynamicDepthTokens.set(token, exchange);
        this.ws?.subscribeDepth([`${exchange}|${token}`]);
    }

    async unsubscribeOptionDepth(token: string, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<void> {
        if (!this.dynamicDepthTokens.has(token)) return;
        const actualExchange = this.dynamicDepthTokens.get(token)!;
        this.dynamicDepthTokens.delete(token);
        this.ws?.unsubscribeDepth([`${actualExchange}|${token}`]);
    }

    disconnect(): void {
        this.manualDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const ws = this.ws;
        this.ws = null;
        ws?.close();
        this.connected = false;
    }
}

export default AntDataStream;
