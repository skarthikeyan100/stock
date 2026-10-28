import Log from '../util/Log';
import { isPastMarketClose } from '../util/marketHours';
import AntSession from './AntSession';
import AntWebSocket from './AntWebSocket';
import ANT from './ANT';
import AntContractMaster from './AntContractMaster';
import myEmitter from '../tools/emitter';
import Mongo from '../tools/mongo';
import configService from '../prism/ConfigService';
import { NiftyQuote, OptionQuote, SensexQuote } from '../model/model';
import Monitor from '../monitor';
import Decision from '../decision';

class AntStream {
  private static instance: AntStream;
  private ws: AntWebSocket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 2000;
  private readonly MAX_RECONNECT_DELAY_MS = 30000;
  private manualDisconnect = false;

  private TARGET_INSTRUMENTS = [
    { exch: 'NSE', token: '26000' }, // NIFTY index
    { exch: 'BSE', token: '1' }, // SENSEX index
  ];

  private INDEX_TOKEN = '26000';
  private SENSEX_TOKEN = '1';

  // Per-position option tokens added/removed dynamically as trades open/close
  // (mirrors what Prism.subscribeOption/unsubscribeOption used to do over its
  // own WS) - the only option tokens AntStream ever subscribes to; the fixed
  // TARGET_INSTRUMENTS above are indices only.
  // Maps bare token -> exchange ('NFO'/'BFO') so BFO (SENSEX) tokens resubscribe
  // and unsubscribe under the exchange they were subscribed with.
  private dynamicOptionTokens: Map<string, 'NFO' | 'BFO'> = new Map();
  private connecting: Promise<void> | null = null;

  static getInstance(): AntStream {
    if (!AntStream.instance) {
      AntStream.instance = new AntStream();
    }
    return AntStream.instance;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      Log.log('[AntStream] Already connected');
      return;
    }
    // In-flight guard: concurrent callers (reconnect timer + /ant/connect) share one attempt.
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.manualDisconnect = false;

    try {
      Log.log('[AntStream] Connecting to ANT streaming...');

      const session = AntSession.getInstance();
      const sessionId = await session.getSessionId();
      Log.log('[AntStream] Got sessionId');

      await session.prepareWsSession(sessionId);
      Log.log('[AntStream] Prepared WS session');

      const susertoken = session.getSusertoken(sessionId);
      const ant = ANT.getInstance();
      const userId = ant.getUserId();

      if (!userId) {
        throw new Error('userId not available');
      }

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
        Log.log('[AntStream] WebSocket open, subscribing...');
        const fixedKeys = this.TARGET_INSTRUMENTS.map((i) => `${i.exch}|${i.token}`);
        const dynamicKeys = Array.from(this.dynamicOptionTokens, ([t, exch]) => `${exch}|${t}`);
        ws.subscribe([...fixedKeys, ...dynamicKeys]);
      });

      ws.on('quote', (_event, data) => {
        if (this.ws !== ws) return;
        myEmitter.emit('ant-quote', data);
        this.persistQuote(data);
        this.broadcastQuote(data);
      });

      ws.on('error', (_event, error) => {
        Log.log('[AntStream] WebSocket error:', error);
      });

      ws.on('close', () => {
        if (this.ws !== ws) return; // superseded/manually closed socket
        Log.log('[AntStream] WebSocket closed');
        this.ws = null;
        this.connected = false;
        if (this.manualDisconnect) return;
        if (isPastMarketClose()) {
          Log.log('[AntStream] Past market close - not reconnecting');
          return;
        }
        this.scheduleReconnect();
      });

      this.ws = ws;
      try {
        await ws.connect({
          susertoken,
          actid: userId + '_API',
          uid: userId + '_API',
        });
      } catch (e) {
        if (this.ws === ws) this.ws = null;
        try { ws.close(); } catch (_) { /* ignore */ }
        throw e;
      }
      if (this.ws !== ws) return; // disconnect() raced the connect

      Log.log('[AntStream] WebSocket connected, subscribing to instruments...');

      this.connected = true;
      this.reconnectDelayMs = 2000; // reset backoff on a successful connect
      Log.log('[AntStream] Connected and streaming');
    } catch (e) {
      Log.log('[AntStream] Connection failed:', e);
      throw e;
    }
  }

  // Auto-reconnect with exponential backoff - previously a dropped websocket
  // just sat there until someone manually hit /ant/connect (see AntDataStream.ts,
  // which already has this same pattern for the `data` process's own connection).
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    Log.log(`[AntStream] Reconnecting in ${this.reconnectDelayMs}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((e) => {
        Log.log('[AntStream] Reconnect attempt failed:', e);
        if (isPastMarketClose()) {
          Log.log('[AntStream] Past market close - not retrying');
          return;
        }
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.MAX_RECONNECT_DELAY_MS);
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  // Mirrors AntDataStream.reconnect()'s semantics (manual /ant/connect-parity trigger).
  async reconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Wait out any in-flight attempt so we don't tear it down mid-handshake;
    // superseded sockets' close events are ignored via the identity check.
    if (this.connecting) {
      try { await this.connecting; } catch (e) { /* retry below */ }
    }
    this.disconnect();
    this.manualDisconnect = false;
    await this.connect();
  }

  // Broadcasts ticks the same way Prism.quote() used to for Shoonya - ANT is now
  // the platform's sole live quote source. Prism's WS stays connected (needed for
  // order-fill notifications via Prism.order()), but no longer feeds quotes.
  private async broadcastQuote(data: any): Promise<void> {
    if (!data.lp) return;

    try {
      if (data.tk === this.INDEX_TOKEN) {
        const quote = NiftyQuote.fromAnt(data);
        await Monitor.getInstance().onNiftyQuote(quote);
        Decision.getInstance().decidePurchase(quote);
        myEmitter.emit('nifty', { nifty: quote });
      } else if (data.tk === this.SENSEX_TOKEN) {
        const quote = SensexQuote.fromAnt(data);
        await Monitor.getInstance().onSensexQuote(quote);
        myEmitter.emit('sensex', { sensex: quote });
      } else if (this.dynamicOptionTokens.has(data.tk)) {
        await Monitor.getInstance().updateQuote(OptionQuote.fromAnt(data));
      }
    } catch (e) {
      Log.log('[AntStream] Broadcast failed:', e);
    }
  }

  // Persists ticks into the same Mongo collections Shoonya used to write
  // (OptionQuote/NiftyQuote, keyed off the object's class name by Mongo.insert()).
  private persistQuote(data: any): void {
    if (!data.lp) {
      return; // partial depth-only update, nothing new to store
    }
    if (!configService.getConfig().settings?.logQuotes) {
      return;
    }

    try {
      if (data.tk === this.INDEX_TOKEN) {
        Mongo.getInstance()?.insert(NiftyQuote.fromAnt(data))?.catch((e) => Log.log('[mongo] quote insert failed:', e));
      } else if (data.tk === this.SENSEX_TOKEN) {
        Mongo.getInstance()?.insert(SensexQuote.fromAnt(data))?.catch((e) => Log.log('[mongo] quote insert failed:', e));
      } else if (this.dynamicOptionTokens.has(data.tk)) {
        Mongo.getInstance()?.insert(OptionQuote.fromAnt(data))?.catch((e) => Log.log('[mongo] quote insert failed:', e));
      }
    } catch (e) {
      Log.log('[AntStream] Mongo insert failed:', e);
    }
  }

  // Dynamic per-position touchline subscribe/unsubscribe - same NFO|<token> key
  // shape used for the fixed TARGET_INSTRUMENTS at connect time.
  // Existing callers pass only the token; resolve its exchange from the contract master so SENSEX (BFO)
  // tokens subscribe under BFO instead of silently getting no ticks as NFO.
  private resolveExchange(token: string): 'NFO' | 'BFO' {
    try {
      return AntContractMaster.getInstance().findByToken(token)?.exch === 'BFO' ? 'BFO' : 'NFO';
    } catch {
      return 'NFO';
    }
  }

  async subscribeOption(token: string, exchange?: 'NFO' | 'BFO'): Promise<void> {
    if (this.dynamicOptionTokens.has(token)) return;
    exchange = exchange ?? this.resolveExchange(token);
    this.dynamicOptionTokens.set(token, exchange);
    this.ws?.subscribe([`${exchange}|${token}`]);
  }

  async unsubscribeOption(token: string, _exchange?: 'NFO' | 'BFO'): Promise<void> {
    const exch = this.dynamicOptionTokens.get(token);
    if (!exch) return;
    this.dynamicOptionTokens.delete(token);
    this.ws?.unsubscribe([`${exch}|${token}`]);
  }

  disconnect(): void {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export default AntStream;
