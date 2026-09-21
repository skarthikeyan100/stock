import WebSocket from 'ws';
import Log from '../util/Log';

type TriggerCallback = (event: string, data?: any) => void;

// Pure staleness check, extracted so it can be unit-tested without a real
// socket - see src/test/antWebSocketWatchdog.test.ts. A connection is
// "stale" once more than thresholdMs has elapsed since the last message or
// pong was received.
export function isStale(lastMessageTime: number, now: number, thresholdMs: number): boolean {
  return now - lastMessageTime > thresholdMs;
}

class AntWebSocket {
  private ws: WebSocket | null = null;
  private url = 'wss://ws1.aliceblueonline.com/NorenWS/';
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private heartbeatMs = 3000; // 3s, matches pya3 ping_interval=3 and this repo's Shoonya Config.heartbeat
  // 4x the heartbeat interval: tolerates a couple of missed pings/transient
  // network jitter without false-positiving, while still catching a real
  // zombie connection ~60x faster than the 12-minute incident that motivated
  // this fix. See plans/bug-07-zombie-websocket-undetectable.md for the
  // full rationale.
  private staleThresholdMs = this.heartbeatMs * 4; // 12000ms
  private lastMessageTime = 0;
  private triggers: Record<string, TriggerCallback[]> = {};

  connect(params: { susertoken: string; actid: string; uid: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url, undefined, { rejectUnauthorized: false });

        // Transport-level liveness signal: fires whenever a ping we sent
        // (via ws.ping() in the heartbeat below) is answered by the peer,
        // independent of whether the Noren/Omnesys app protocol acks our
        // {t:'h'} message. Keeps lastMessageTime advancing during quiet
        // markets (no ticks) as long as the socket is genuinely alive.
        this.ws.on('pong', () => {
          this.lastMessageTime = Date.now();
        });

        this.ws.onopen = () => {
          Log.log('[AntWS] Connected, sending auth payload...');
          const initCon = {
            susertoken: params.susertoken,
            t: 'c',
            actid: params.actid,
            uid: params.uid,
            source: 'API',
          };
          this.ws!.send(JSON.stringify(initCon));

          this.lastMessageTime = Date.now();

          // Start heartbeat
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ t: 'h' }));
              this.ws.ping();
            }
          }, this.heartbeatMs);

          // Start watchdog: detects a half-open ("zombie") connection where
          // readyState stays OPEN but the server has stopped responding (no
          // messages, no pongs). terminate() (not close()) is used because
          // a dead peer will never complete a graceful close handshake -
          // terminate() destroys the socket immediately and reliably fires
          // the 'close' event below, which is what triggers AntStream's
          // reconnect logic.
          if (this.watchdogInterval) clearInterval(this.watchdogInterval);
          this.watchdogInterval = setInterval(() => {
            if (isStale(this.lastMessageTime, Date.now(), this.staleThresholdMs)) {
              Log.log(`[AntWS] No message/pong received in over ${this.staleThresholdMs}ms - connection appears dead, terminating`);
              this.ws?.terminate();
            }
          }, this.heartbeatMs);

          resolve();
        };

        this.ws.onmessage = (event) => {
          this.lastMessageTime = Date.now();
          try {
            const text = typeof event.data === 'string' ? event.data : event.data.toString('utf-8');
            const data = JSON.parse(text);
            if (data.t === 'ck' || data.t === 'cf') {
              Log.log('[AntWS] Connect ack:', data);
              this.trigger('open', data);
            } else if (data.t === 'tk' || data.t === 'tf' || data.t === 'dk' || data.t === 'df') {
              // Depth ack/update ('dk'/'df') is a superset of touchline
              // ('tk'/'tf') - also carries 'lp' plus 'tbq'/'tsq' (total buy/
              // sell qty), only available in depth mode. Routed through the
              // same 'quote' event so every existing consumer (which only
              // reads 'lp'/'tk'/'ft') keeps working unchanged; only
              // depth-aware code (see OptionQuote.fromAnt) reads tbq/tsq.
              this.trigger('quote', data);
            }
          } catch (e) {
            Log.log('[AntWS] Message parse error:', e);
          }
        };

        this.ws.onerror = (event) => {
          Log.log('[AntWS] WebSocket error:', event);
          this.trigger('error', event);
          reject(event);
        };

        this.ws.onclose = () => {
          Log.log('[AntWS] WebSocket closed');
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
          if (this.watchdogInterval) clearInterval(this.watchdogInterval);
          this.trigger('close');
        };
      } catch (e) {
        Log.log('[AntWS] Connect error:', e);
        reject(e);
      }
    });
  }

  subscribe(keys: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      Log.log('[AntWS] Cannot subscribe: connection not open');
      return;
    }
    const k = keys.join('#');
    const msg = { k, t: 't' };
    Log.log('[AntWS] Subscribing:', k);
    this.ws.send(JSON.stringify(msg));
  }

  unsubscribe(keys: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      Log.log('[AntWS] Cannot unsubscribe: connection not open');
      return;
    }
    const k = keys.join('#');
    const msg = { k, t: 'u' };
    Log.log('[AntWS] Unsubscribing:', k);
    this.ws.send(JSON.stringify(msg));
  }

  // Depth mode - separate AliceBlue subscription type from touchline above,
  // needed only for tbq/tsq (total buy/sell qty), which touchline does not
  // carry. A token can be depth- and touchline-subscribed independently.
  subscribeDepth(keys: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      Log.log('[AntWS] Cannot subscribe (depth): connection not open');
      return;
    }
    const k = keys.join('#');
    const msg = { k, t: 'd' };
    Log.log('[AntWS] Subscribing (depth):', k);
    this.ws.send(JSON.stringify(msg));
  }

  unsubscribeDepth(keys: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      Log.log('[AntWS] Cannot unsubscribe (depth): connection not open');
      return;
    }
    const k = keys.join('#');
    const msg = { k, t: 'ud' };
    Log.log('[AntWS] Unsubscribing (depth):', k);
    this.ws.send(JSON.stringify(msg));
  }

  on(event: string, callback: TriggerCallback): void {
    if (!this.triggers[event]) {
      this.triggers[event] = [];
    }
    this.triggers[event].push(callback);
  }

  private trigger(event: string, data?: any): void {
    if (this.triggers[event]) {
      this.triggers[event].forEach((cb) => cb(event, data));
    }
  }

  close(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.ws) {
      this.ws.close();
    }
  }
}

export default AntWebSocket;
