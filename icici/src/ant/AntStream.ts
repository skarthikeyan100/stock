import Log from '../util/Log';
import AntSession from './AntSession';
import AntWebSocket from './AntWebSocket';
import ANT from './ANT';
import myEmitter from '../tools/emitter';
import Mongo from '../tools/mongo';
import configService from '../prism/ConfigService';
import { NiftyQuote, OptionQuote } from '../model/model';
import Monitor from '../monitor';
import Decision from '../decision';

class AntStream {
  private static instance: AntStream;
  private ws: AntWebSocket | null = null;
  private connected = false;

  private TARGET_INSTRUMENTS = [
    { exch: 'NSE', token: '26000' }, // NIFTY index
    { exch: 'NFO', token: '45105' }, // NIFTY 24350 PE 18-Aug-26
    { exch: 'BFO', token: '855410' }, // SENSEX 77400 PE 20-Aug-26
  ];

  private INDEX_TOKEN = '26000';
  private OPTION_TOKENS = new Set(
    this.TARGET_INSTRUMENTS.filter((i) => i.token !== this.INDEX_TOKEN).map((i) => i.token)
  );

  // Per-position option tokens added/removed dynamically as trades open/close
  // (mirrors what Prism.subscribeOption/unsubscribeOption used to do over its
  // own WS) - kept separate from the fixed demo/test OPTION_TOKENS above.
  private dynamicOptionTokens: Set<string> = new Set();

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

      this.ws = new AntWebSocket();

      await this.ws.connect({
        susertoken,
        actid: userId + '_API',
        uid: userId + '_API',
      });

      Log.log('[AntStream] WebSocket connected, subscribing to instruments...');

      this.ws.on('open', () => {
        Log.log('[AntStream] WebSocket open, subscribing...');
        const fixedKeys = this.TARGET_INSTRUMENTS.map((i) => `${i.exch}|${i.token}`);
        const dynamicKeys = Array.from(this.dynamicOptionTokens).map((t) => `NFO|${t}`);
        this.ws!.subscribe([...fixedKeys, ...dynamicKeys]);
      });

      this.ws.on('quote', (_event, data) => {
        Log.log('[AntStream] Quote:', data);
        myEmitter.emit('ant-quote', data);
        this.persistQuote(data);
        this.broadcastQuote(data);
      });

      this.ws.on('error', (_event, error) => {
        Log.log('[AntStream] WebSocket error:', error);
      });

      this.ws.on('close', () => {
        Log.log('[AntStream] WebSocket closed');
        this.connected = false;
      });

      this.connected = true;
      Log.log('[AntStream] Connected and streaming');
    } catch (e) {
      Log.log('[AntStream] Connection failed:', e);
      throw e;
    }
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
      } else if (this.OPTION_TOKENS.has(data.tk) || this.dynamicOptionTokens.has(data.tk)) {
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
        Mongo.getInstance()?.insert(NiftyQuote.fromAnt(data));
      } else if (this.OPTION_TOKENS.has(data.tk) || this.dynamicOptionTokens.has(data.tk)) {
        Mongo.getInstance()?.insert(OptionQuote.fromAnt(data));
      }
    } catch (e) {
      Log.log('[AntStream] Mongo insert failed:', e);
    }
  }

  // Dynamic per-position touchline subscribe/unsubscribe - same NFO|<token> key
  // shape used for the fixed TARGET_INSTRUMENTS at connect time.
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

  disconnect(): void {
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
