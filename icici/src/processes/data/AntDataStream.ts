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

    private readonly INDEX_TOKEN = '26000'; // NIFTY
    private readonly SENSEX_TOKEN = '1';
    private readonly ALWAYS_ON = [
        { exch: 'NSE', token: '26000' },
        { exch: 'BSE', token: '1' },
    ];

    private dynamicOptionTokens: Set<string> = new Set();
    // Depth-mode subscriptions - a separate AliceBlue subscription type from
    // dynamicOptionTokens' touchline above, used only for the momentum
    // signal's tbq/tsq (see MomentumSignal.ts). A token can be in both sets
    // independently (e.g. an open leg's touchline token happening to also be
    // momentum-checked).
    private dynamicDepthTokens: Set<string> = new Set();

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

        Log.log('[AntDataStream] Connecting to ANT streaming...');
        const session = AntSession.getInstance();
        const sessionId = await session.getSessionId();
        await session.prepareWsSession(sessionId);
        const susertoken = session.getSusertoken(sessionId);
        const ant = ANT.getInstance();
        const userId = ant.getUserId();
        if (!userId) throw new Error('userId not available');

        this.ws = new AntWebSocket();
        await this.ws.connect({ susertoken, actid: userId + '_API', uid: userId + '_API' });

        this.ws.on('open', () => {
            Log.log('[AntDataStream] WebSocket open, subscribing to always-on instruments...');
            const fixedKeys = this.ALWAYS_ON.map((i) => `${i.exch}|${i.token}`);
            const dynamicKeys = Array.from(this.dynamicOptionTokens).map((t) => `NFO|${t}`);
            this.ws!.subscribe([...fixedKeys, ...dynamicKeys]);
            if (this.dynamicDepthTokens.size > 0) {
                this.ws!.subscribeDepth(Array.from(this.dynamicDepthTokens).map((t) => `NFO|${t}`));
            }
        });

        this.ws.on('quote', (_event, data) => {
            this.persistQuote(data);
            this.emitTick(data);
        });

        this.ws.on('error', (_event, error) => {
            Log.log('[AntDataStream] WebSocket error:', error);
        });

        this.ws.on('close', () => {
            Log.log('[AntDataStream] WebSocket closed');
            this.connected = false;
            if (this.manualDisconnect) return;
            if (isPastMarketClose()) {
                Log.log('[AntDataStream] Past market close - not reconnecting');
                return;
            }
            this.scheduleReconnect();
        });

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
        this.manualDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
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
                Mongo.getInstance()?.insert(NiftyQuote.fromAnt(data));
            } else if (data.tk === this.SENSEX_TOKEN) {
                Mongo.getInstance()?.insert(SensexQuote.fromAnt(data));
            } else if (this.dynamicOptionTokens.has(data.tk) || this.dynamicDepthTokens.has(data.tk)) {
                Mongo.getInstance()?.insert(OptionQuote.fromAnt(data));
            }
        } catch (e) {
            Log.log('[AntDataStream] Mongo insert failed:', e);
        }
    }

    async subscribeOption(token: string): Promise<void> {
        if (this.dynamicOptionTokens.has(token)) return;
        this.dynamicOptionTokens.add(token);
        this.ws?.subscribe([`NFO|${token}`]);
    }

    async unsubscribeOption(token: string): Promise<void> {
        if (!this.dynamicOptionTokens.has(token)) return;
        this.dynamicOptionTokens.delete(token);
        this.ws?.unsubscribe([`NFO|${token}`]);
    }

    async subscribeOptionDepth(token: string): Promise<void> {
        if (this.dynamicDepthTokens.has(token)) return;
        this.dynamicDepthTokens.add(token);
        this.ws?.subscribeDepth([`NFO|${token}`]);
    }

    async unsubscribeOptionDepth(token: string): Promise<void> {
        if (!this.dynamicDepthTokens.has(token)) return;
        this.dynamicDepthTokens.delete(token);
        this.ws?.unsubscribeDepth([`NFO|${token}`]);
    }

    disconnect(): void {
        this.ws?.close();
        this.ws = null;
        this.connected = false;
    }
}

export default AntDataStream;
