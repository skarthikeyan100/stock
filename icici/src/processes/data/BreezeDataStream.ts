import Log from '../../util/Log';
import Breeze from '../../breeze/Breeze';
import { OptionQuote } from '../../model/model';
import { DataStream } from './DataStream';

// data process's Breeze-native tick source, mirroring AntDataStream.ts's
// shape. Bypasses breezeconnect's broken structured-params subscribeFeeds
// path (self.stockScriptDictList is never populated in this app's session
// flow - see Breeze.ts's generateSession() comment) by always subscribing via
// the explicit stockToken form ("4.1!<token>"), where <token> is
// BreezeContractMaster.FnoRecord.token - the exact same value already stored
// on Trade.token for Breeze-executed legs, so no separate contract lookup is
// needed at subscribe time.
//
// Confirmed live (2026-09-18, real NIFTY23300PE position, token 56994):
// subscribeFeeds({stockToken}) works and real ticks arrive - but only once
// the session is fully restored (hasValidSession()) BEFORE wsConnect() is
// called. wsConnect() synchronously captures self.userId/self.sessionKey into
// the socket.io `auth` object at connect time; if the session hasn't been
// restored yet (self.userId still ""), the handshake fails with "Credentials
// Missing" and no amount of subscribing afterward recovers it - the socket
// never actually connects. subscribeFeeds()'s own ensureSessionRestored()
// call happens too late to fix this, since by then wsConnect() has already
// fired the (failed) handshake.
class BreezeDataStream implements DataStream {
    private static instance: BreezeDataStream;
    private dynamicOptionTokens: Set<string> = new Set();
    private connected = false;

    private constructor(private writeTick: (tick: any) => void) {}

    static getInstance(writeTick: (tick: any) => void): BreezeDataStream {
        if (!BreezeDataStream.instance) {
            BreezeDataStream.instance = new BreezeDataStream(writeTick);
        }
        return BreezeDataStream.instance;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            Log.log('[BreezeDataStream] Already connected');
            return;
        }

        const breeze = Breeze.getInstance();
        const valid = await breeze.hasValidSession();
        if (!valid) {
            throw new Error('Breeze session not available. Complete OAuth login first (/breeze/login).');
        }

        breeze.onQuote((tick) => this.emitTick(tick));
        breeze.onSocketConnect(() => {
            Log.log('[BreezeDataStream] socket connected, (re)subscribing to', this.dynamicOptionTokens.size, 'token(s)');
            for (const token of this.dynamicOptionTokens) this.sendSubscribe(token);
        });
        breeze.onSocketDisconnect((reason) => Log.log('[BreezeDataStream] socket disconnected:', reason));
        breeze.onSocketError((e) => Log.log('[BreezeDataStream] socket connect_error:', e?.message ?? e));

        breeze.wsConnect();
        this.connected = true;
        Log.log('[BreezeDataStream] Connected and streaming');
        this.startStallWatchdog();
        this.startHeartbeat();
    }

    // A real subscription went silent for 40+ minutes on 2026-09-18 with zero
    // log trace (no disconnect/error, subscribeFeeds ack'd fine) while the
    // real market price kept moving - LegManager never saw it, twice, in live
    // testing the same day. socket.io already runs its own low-level
    // ping/pong (confirmed via web research - not the missing piece, and
    // consistent with no disconnect ever firing); real-world reports on
    // ICICI's own Breeze-Python-SDK GitHub repo (#54, #110, #149, #152)
    // describe this exact class of failure - the feed subscription silently
    // dying while the socket itself stays nominally connected. This watchdog
    // surfaces it loudly AND now actively recovers (see startHeartbeat/
    // resubscribeStale below) rather than only logging. Checked every 30s;
    // logs once per stale token per check (not per tick) so it stays cheap
    // even during a long stall.
    private readonly STALL_THRESHOLD_MS = 60000;
    private lastTickAt = new Map<string, number>();
    private watchdogTimer: NodeJS.Timeout | null = null;
    private resubscribedWhileStale = new Set<string>(); // avoids re-issuing subscribeFeeds every 30s during one prolonged stall

    private startStallWatchdog(): void {
        if (this.watchdogTimer) return;
        this.watchdogTimer = setInterval(() => {
            const now = Date.now();
            for (const token of this.dynamicOptionTokens) {
                const last = this.lastTickAt.get(token);
                const age = last ? now - last : null;
                if (age === null || age >= this.STALL_THRESHOLD_MS) {
                    Log.log(
                        `[BreezeDataStream] WATCHDOG: no tick for token=${token} in ${age === null ? 'ever (since subscribe)' : Math.round(age / 1000) + 's'} - socket connected=${this.connected}`
                    );
                    if (!this.resubscribedWhileStale.has(token)) {
                        this.resubscribedWhileStale.add(token);
                        Log.log(`[BreezeDataStream] WATCHDOG-triggered resubscribe: ${token}`);
                        this.sendSubscribe(token);
                    }
                }
            }
        }, 30000);
    }

    // Independent of any detected disconnect - a defensive re-subscribe on a
    // fixed timer, since a server-side silent subscription drop (see above)
    // gives no client-visible signal to react to otherwise. subscribeFeeds/
    // self.watch(stockToken) is idempotent (confirmed live - resubscribing an
    // already-subscribed token is safe, no duplicate-tick side effects
    // observed), so this is cheap insurance, not a risky operation.
    private readonly HEARTBEAT_MS = 3 * 60 * 1000;
    private heartbeatTimer: NodeJS.Timeout | null = null;

    private startHeartbeat(): void {
        if (this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(() => {
            for (const token of this.dynamicOptionTokens) {
                Log.log(`[BreezeDataStream] heartbeat resubscribe: ${token}`);
                this.sendSubscribe(token);
            }
        }, this.HEARTBEAT_MS);
    }

    async reconnect(): Promise<void> {
        this.disconnect();
        await this.connect();
    }

    private sendSubscribe(token: string): void {
        Breeze.getInstance()
            .subscribeFeeds({ stockToken: `4.1!${token}`, getExchangeQuotes: true, getMarketDepth: false })
            .then(() => Log.log('[BreezeDataStream] subscribed:', token))
            .catch((e) => Log.log('[BreezeDataStream] subscribeFeeds failed:', token, e));
    }

    async subscribeOption(token: string): Promise<void> {
        if (this.dynamicOptionTokens.has(token)) return;
        this.dynamicOptionTokens.add(token);
        if (this.connected) this.sendSubscribe(token);
    }

    async unsubscribeOption(token: string): Promise<void> {
        if (!this.dynamicOptionTokens.has(token)) return;
        this.dynamicOptionTokens.delete(token);
        this.lastTickAt.delete(token);
        this.lastLoggedAt.delete(token);
        this.resubscribedWhileStale.delete(token);
        if (!this.connected) return;
        await Breeze.getInstance()
            .unsubscribeFeeds({ stockToken: `4.1!${token}`, getExchangeQuotes: true, getMarketDepth: false })
            .catch((e) => Log.log('[BreezeDataStream] unsubscribeFeeds failed:', token, e));
    }

    // Throttled per-token diagnostic logging - full per-tick logging would
    // flood orchestrator.log, but silent per-tick handling was exactly what
    // made an earlier real stall (ticks stopped arriving with zero log trace)
    // hard to diagnose. Logs the raw tick at most once per LOG_THROTTLE_MS
    // per token, plus every ignored/stray tick (should be rare) so a token
    // mismatch or subscription drop is visible immediately instead of only
    // showing up as "nothing happened."
    private readonly LOG_THROTTLE_MS = 10000;
    private lastLoggedAt = new Map<string, number>();

    private emitTick(tick: any): void {
        try {
            const quote = OptionQuote.fromBreeze(tick);
            if (!quote.token || !this.dynamicOptionTokens.has(quote.token)) {
                Log.log('[BreezeDataStream] Ignoring stray/unrecognized tick:', JSON.stringify(tick));
                return;
            }
            const now = Date.now();
            this.lastTickAt.set(quote.token, now);
            this.resubscribedWhileStale.delete(quote.token); // a real tick arrived - re-arm the watchdog's resubscribe for the next stall
            const last = this.lastLoggedAt.get(quote.token) ?? 0;
            if (now - last >= this.LOG_THROTTLE_MS) {
                this.lastLoggedAt.set(quote.token, now);
                Log.log(`[BreezeDataStream] tick token=${quote.token} ltp=${quote.ltp} raw=${JSON.stringify(tick)}`);
            }
            this.writeTick({ type: 'option', source: 'breeze', quote });
        } catch (e) {
            Log.log('[BreezeDataStream] emitTick failed:', e, 'raw=', JSON.stringify(tick));
        }
    }

    disconnect(): void {
        Breeze.getInstance().wsDisconnect();
        this.connected = false;
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

export default BreezeDataStream;
