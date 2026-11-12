import Log from '../../util/Log';
import { isPastMarketClose } from '../../util/marketHours';
import AntSession from '../../ant/AntSession';
import AntWebSocket from '../../ant/AntWebSocket';
import ANT from '../../ant/ANT';
import Mongo from '../../tools/mongo';
import configService from '../../prism/ConfigService';
import AntContractMaster from '../../ant/AntContractMaster';
import { FutVwapTracker } from '../../lib/futVwap';
import { localDayKey } from '../../strategy/dayKey';
import { FutQuote, NiftyQuote, OptionQuote, SensexQuote } from '../../model/model';
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
    // The current-month NIFTY future: its `ap` (exchange VWAP) and `v` feed BreakoutStrategy. Resolved from the contract master on every
    // (re)connect, so it rolls to the next month by itself after expiry.
    private futToken: string | null = null;
    private futSymbol = '';
    private readonly futVwap = new FutVwapTracker();
    private futTicks = 0;
    private firstFutTickLogged = false;
    private firstFutTickAt = 0;
    private lastFutTickAt = 0;
    private lastFutHeartbeatAt = 0;
    private lastFutAlertAt = 0;
    private lastFutMissingAlertAt = 0;
    private readonly FUT_HEARTBEAT_MS = 60_000;
    private readonly FUT_ALERT_REPEAT_MS = 5 * 60_000;
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
            const futKey = this.resolveFuture();
            if (futKey) fixedKeys.push(futKey);
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

    // Looks up the nearest NIFTY future and returns its subscription key, or null (logged) when the contract master has none. A failure here
    // must never stop the index/option subscriptions, so it is caught.
    private resolveFuture(): string | null {
        try {
            const fut = AntContractMaster.getInstance().findNearestFuture('NIFTY', 'NFO');
            if (this.futToken !== fut.token) {
                this.firstFutTickLogged = false;
                this.firstFutTickAt = 0;
            }
            this.futToken = fut.token;
            this.futSymbol = fut.tradingSymbol;
            Log.log(`[VWAP-FEED] subscribing NIFTY future ${fut.tradingSymbol} token ${fut.token} (expires ${new Date(fut.expiryMs).toISOString().slice(0, 10)}) for VWAP`);
            return `NFO|${fut.token}`;
        } catch (e: any) {
            this.futToken = null;
            Log.log(`[VWAP-FEED] ALERT: could not resolve the NIFTY future (${e?.message ?? e}) - no VWAP feed; BreakoutStrategy will not trade`);
            return null;
        }
    }

    // One future tick: merge the partial update, log the first raw tick of the day and a once-a-minute heartbeat (exchange `ap` next to our
    // own volume-weighted figure), store the heartbeat in Mongo (vwapSamples) and emit a FutQuote.
    private onFutTick(data: any): void {
        const now = Date.now();
        const day = localDayKey();
        this.lastFutTickAt = now;
        this.futTicks++;
        if (!this.firstFutTickLogged) {
            this.firstFutTickLogged = true;
            this.firstFutTickAt = now;
            Log.log(`[VWAP-FEED] first ${this.futSymbol} tick of the day, raw fields: ${JSON.stringify({ t: data.t, tk: data.tk, lp: data.lp, v: data.v, ap: data.ap, ltq: data.ltq, ft: data.ft, oi: data.oi })}`);
        }
        const issues = this.futVwap.update({ lp: data.lp, v: data.v, ap: data.ap }, day);
        for (const issue of issues) {
            if (now - this.lastFutAlertAt >= this.FUT_ALERT_REPEAT_MS) {
                this.lastFutAlertAt = now;
                Log.log(`[VWAP-FEED] ALERT: ${this.futSymbol} ${issue} (raw v=${data.v}, ap=${data.ap}, lp=${data.lp})`);
            }
        }
        const st = this.futVwap.state();
        const best = this.futVwap.best();
        if (now - this.lastFutHeartbeatAt >= this.FUT_HEARTBEAT_MS) {
            this.lastFutHeartbeatAt = now;
            const diff = st.exchangeVwap !== undefined && st.ownVwap !== undefined ? (st.ownVwap - st.exchangeVwap).toFixed(2) : 'n/a';
            Log.log(`[VWAP-FEED] ${this.futSymbol} ltp ${Number.isFinite(st.ltp) ? st.ltp : 'n/a'} | ap ${st.exchangeVwap?.toFixed(2) ?? 'MISSING'} | own vwap ${st.ownVwap?.toFixed(2) ?? 'n/a'} (own - ap = ${diff}) | v ${st.volume ?? 'n/a'} (own since v ${st.ownSinceVolume ?? 'n/a'}) | ticks ${this.futTicks}`);
            try {
                Mongo.getInstance()?.tryInsert({ day, at: new Date(), token: this.futToken, tsym: this.futSymbol, ltp: Number.isFinite(st.ltp) ? st.ltp : null, ap: st.exchangeVwap ?? null, ownVwap: st.ownVwap ?? null, v: st.volume ?? null }, 'vwapSamples');
            } catch (e) { /* logging only */ }
            if (st.exchangeVwap === undefined && this.firstFutTickAt > 0 && now - this.firstFutTickAt >= 60_000 && now - this.lastFutMissingAlertAt >= this.FUT_ALERT_REPEAT_MS) {
                this.lastFutMissingAlertAt = now;
                Log.log(`[VWAP-FEED] ALERT: no ap (exchange VWAP) on ${this.futSymbol} ${Math.round((now - this.firstFutTickAt) / 1000)}s after its first tick - using the own volume-weighted VWAP${st.ownVwap === undefined ? ' (none yet: no volume seen either)' : ''}`);
            }
        }
        if (!Number.isFinite(st.ltp)) return; // nothing priced yet (a tick carrying only v/ap before the first lp)
        const quote = new FutQuote();
        quote.ltp = st.ltp;
        quote.ltt = data.ft ?? String(Math.floor(now / 1000)); // a v/ap-only update may carry no ft
        quote.token = String(data.tk);
        quote.volume = st.volume;
        quote.exchangeVwap = st.exchangeVwap;
        quote.ownVwap = st.ownVwap;
        quote.vwap = best?.vwap;
        quote.vwapSource = best?.source;
        this.writeTick({ type: 'fut', quote });
    }

    // A NIFTY tick arrived but the future has been silent for a minute: logged at most every 5 minutes.
    private checkFutSilence(): void {
        if (!this.futToken || this.firstFutTickAt === 0) return;
        const now = Date.now();
        if (now - this.lastFutTickAt >= 60_000 && now - this.lastFutAlertAt >= this.FUT_ALERT_REPEAT_MS) {
            this.lastFutAlertAt = now;
            Log.log(`[VWAP-FEED] ALERT: no ${this.futSymbol} tick for ${Math.round((now - this.lastFutTickAt) / 1000)}s while NIFTY ticks keep arriving`);
        }
    }

    private emitTick(data: any): void {
        if (this.futToken && data.tk === this.futToken) {
            // A future update can carry only v/ap (no lp): it still moves the VWAP, so the usual "no lp, nothing new" guard is skipped for it.
            try { this.onFutTick(data); } catch (e) { Log.log('[AntDataStream] fut tick failed:', e); }
            return;
        }
        // Depth feed updates ('df') are sparse - a tick carrying a fresh
        // tbq/tsq for a depth-tracked token doesn't always also carry 'lp',
        // so the usual "no lp, nothing new" short-circuit would silently
        // drop it. Relax the guard only for tokens actually depth-tracked.
        const isDepthTracked = this.dynamicDepthTokens.has(data.tk);
        if (!data.lp && !(isDepthTracked && (data.tbq !== undefined || data.tsq !== undefined))) return;
        try {
            if (data.tk === this.INDEX_TOKEN) {
                this.checkFutSilence();
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
