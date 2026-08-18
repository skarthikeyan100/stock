import WebSocket from 'ws';
import Log from '../util/Log';

type TriggerCallback = (event: string, data?: any) => void;

class AntWebSocket {
  private ws: WebSocket | null = null;
  private url = 'wss://ws1.aliceblueonline.com/NorenWS/';
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatMs = 3000; // 3s, matches pya3 ping_interval=3 and this repo's Shoonya Config.heartbeat
  private triggers: Record<string, TriggerCallback[]> = {};

  connect(params: { susertoken: string; actid: string; uid: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url, undefined, { rejectUnauthorized: false });

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

          // Start heartbeat
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ t: 'h' }));
            }
          }, this.heartbeatMs);

          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const text = typeof event.data === 'string' ? event.data : event.data.toString('utf-8');
            const data = JSON.parse(text);
            if (data.t === 'ck' || data.t === 'cf') {
              Log.log('[AntWS] Connect ack:', data);
              this.trigger('open', data);
            } else if (data.t === 'tk' || data.t === 'tf') {
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
    if (this.ws) {
      this.ws.close();
    }
  }
}

export default AntWebSocket;
