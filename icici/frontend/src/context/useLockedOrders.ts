import { useCallback, useEffect, useRef, useState } from 'react';
import { useEventSource } from '../hooks/useEventSource';
import { apiFetch, apiPost, readError } from '../utils/api';
import type { Trade } from './TradingContext';

// Orders at the price the user clicked: the page shows a live price on every buy and square-off button, and the click sends exactly that price
// as the limit of a resting order. Needs a server that takes such orders; `mode` says what the running server can do:
//   'checking' - not known yet (no order is sent from the buy buttons),
//   'locked'   - limit orders at the shown price,
//   'market'   - a server without them: the page behaves as before and says that orders go at market price.

export type OrderMode = 'checking' | 'locked' | 'market';
export type PageIndex = 'NIFTY' | 'SENSEX';

/** A contract and the price shown for it: what a buy click captures. */
export interface PricedContract { contract: string; strike: number; token: string; tradingSymbol: string; price: number }
export interface PendingOrder { orderId: string; broker: string; tsym: string; token: string; action: 'Buy' | 'Sell'; quantity: number; filled: number; price: number }
export interface OrderNotice { id: string; variant: 'success' | 'warning' | 'danger' | 'info'; text: string }

interface StreamQuote { contract: string; strike: number; token: string; tradingSymbol: string; price: number | null; ageMs: number | null }
interface StreamMessage {
  index: PageIndex;
  flash: { call: StreamQuote | null; put: StreamQuote | null };
  contract: StreamQuote | null;
  positions: Array<{ broker: string; tsym: string; token: string; price: number | null; ageMs: number | null }>;
  pending: PendingOrder[] | null;
  outcomes: Array<{ id: string; broker: string; tsym: string; action: 'Buy' | 'Sell'; quantity: number; price: number; status: 'filled' | 'cancelled' | 'rejected'; reason?: string }> | null;
}

export interface LockedOrders {
  flash: { call: PricedContract | null; put: PricedContract | null };
  /** The live price of the contract picked in Search & Buy (set with setSearchContract). */
  searchQuote: PricedContract | null;
  setSearchContract: (contract: string | null) => void;
  positionPrice: (trade: Trade) => number | null;
  pending: PendingOrder[];
  notices: OrderNotice[];
  dismissNotice: (id: string) => void;
  buyFlash: (right: 'call' | 'put', shown: PricedContract) => Promise<boolean>;
  buyContract: (shown: PricedContract, targetPoints?: number, stopLossPoints?: number) => Promise<boolean>;
  squareOffAt: (trade: Trade, shownPrice: number) => Promise<boolean>;
  cancelOrder: (order: PendingOrder) => Promise<void>;
}

// A price older than this is not offered on a button: the order would carry a price the market has left.
const BUY_STALE_MS = 15_000;
// A held contract can trade less often than the at-the-money ones.
const SELL_STALE_MS = 30_000;
// Buttons stay disabled this long after an order, so a double click cannot place a second one.
const CLICK_COOLDOWN_MS = 1_000;
const INDEX_KEY = 'tradingIndex';

export function readSavedIndex(): PageIndex {
  try { return localStorage.getItem(INDEX_KEY) === 'SENSEX' ? 'SENSEX' : 'NIFTY'; } catch { return 'NIFTY'; }
}
export function saveIndex(index: PageIndex): void {
  try { localStorage.setItem(INDEX_KEY, index); } catch { /* storage unavailable: the choice lasts for this page only */ }
}

export const rupees = (v: number) => `₹${v.toFixed(2)}`;

/** Asks the server whether it takes orders at a clicked price, and keeps asking (a server restart changes the answer). */
export function useOrderMode(enabled: boolean): OrderMode {
  const [mode, setMode] = useState<OrderMode>('checking');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      let next: OrderMode | null = null;
      try {
        const res = await apiFetch('/order/locked-capability', { signal: AbortSignal.timeout(8000) });
        // A server without this route answers 404, or its own web page (200, not JSON).
        const json = (res.headers.get('content-type') || '').includes('json');
        if (res.ok) next = json && (await res.json())?.lockedPrice === true ? 'locked' : 'market';
        else if (res.status === 404) next = 'market';
      } catch { /* unreachable: keep what is known */ }
      if (cancelled) return;
      if (next) setMode(next);
      timer = setTimeout(check, next === 'locked' ? 60_000 : next === 'market' ? 20_000 : 3_000);
    };
    check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [enabled]);
  return mode;
}

interface Options {
  mode: OrderMode;
  index: PageIndex;
  setPlacing: (v: boolean) => void;
  setError: (v: string | null) => void;
  describeError: (message: string) => string;
}

export function useLockedOrders({ mode, index, setPlacing, setError, describeError }: Options): LockedOrders | undefined {
  const active = mode === 'locked';
  const [searchContract, setSearchContract] = useState<string | null>(null);
  const [stream, setStream] = useState<{ message: StreamMessage; receivedAt: number } | null>(null);
  const [pending, setPending] = useState<PendingOrder[]>([]);
  const [notices, setNotices] = useState<OrderNotice[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef<Set<string>>(new Set()); // 'buy', or one position / order: a second click on the same thing is ignored
  const seenOutcomes = useRef<Set<string> | null>(null); // null until the first message: what had already happened then is not announced
  const noticeCount = useRef(0);

  const addNotice = useCallback((variant: OrderNotice['variant'], text: string) => {
    const id = `n${++noticeCount.current}`;
    setNotices((prev) => [...prev.slice(-3), { id, variant, text }]);
  }, []);

  // Re-evaluates price ages even when the stream goes quiet.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const url = `/order/pricestream?index=${index}${searchContract ? `&contract=${encodeURIComponent(searchContract)}` : ''}`;
  useEventSource(url, {
    enabled: active,
    onMessage: (event) => {
      try {
        const message = JSON.parse(event.data) as StreamMessage;
        if (!message || !Array.isArray(message.positions)) return;
        const receivedAt = Date.now();
        setStream({ message, receivedAt });
        setNow(receivedAt);
        if (message.pending) setPending(message.pending);
        if (!message.outcomes) return;
        const first = seenOutcomes.current === null;
        const seen = (seenOutcomes.current ??= new Set<string>());
        for (const o of message.outcomes) {
          if (seen.has(o.id)) continue;
          seen.add(o.id);
          if (first) continue;
          const what = `${o.action === 'Buy' ? 'buy' : 'sell'} of ${o.quantity} ${o.tsym}`;
          if (o.status === 'filled') addNotice('success', `${o.action === 'Buy' ? 'Bought' : 'Sold'} ${o.quantity} ${o.tsym} at ${rupees(o.price)}.`);
          else addNotice(o.status === 'rejected' ? 'danger' : 'warning', `Limit ${what} at ${rupees(o.price)} was ${o.status}${o.reason ? `: ${describeError(o.reason)}` : ''}.`);
        }
      } catch (e) {
        console.error('[PriceStream] bad message:', e);
      }
    },
  });

  const age = (ageMs: number | null) => (ageMs === null || !stream ? Infinity : ageMs + Math.max(0, now - stream.receivedAt));
  const priced = (q: StreamQuote | null | undefined): PricedContract | null =>
    q && q.price !== null && q.price > 0 && age(q.ageMs) <= BUY_STALE_MS ? { contract: q.contract, strike: q.strike, token: q.token, tradingSymbol: q.tradingSymbol, price: q.price } : null;

  // Nothing from another index's or another contract's stream is ever offered.
  const current = stream && stream.message.index === index ? stream.message : null;
  const flash = {
    call: current?.flash.call?.contract.startsWith(`${index}_`) ? priced(current.flash.call) : null,
    put: current?.flash.put?.contract.startsWith(`${index}_`) ? priced(current.flash.put) : null,
  };
  const searchQuote = searchContract && stream?.message.contract?.contract === searchContract ? priced(stream.message.contract) : null;

  const positionPrice = (trade: Trade): number | null => {
    // (A row without a broker field is matched by contract alone. No broker name is spelled here: this file is in the bundle contractors load.)
    const p = stream?.message.positions.find((x) => x.token === String(trade.token) && x.tsym === trade.tsym && (!trade.broker || x.broker === trade.broker));
    return p && p.price !== null && p.price > 0 && age(p.ageMs) <= SELL_STALE_MS ? p.price : null;
  };

  // One request at a time per thing: buys share one (a double click never buys twice), and a buy in flight never blocks a square-off.
  const send = async (key: string, path: string, body: unknown, done: (reply: any) => void): Promise<boolean> => {
    if (busy.current.has(key)) return false;
    busy.current.add(key);
    const buying = key === 'buy';
    if (buying) setPlacing(true);
    setError(null);
    try {
      const res = await apiPost(path, body);
      if (!res.ok) { setError(describeError(await readError(res))); return false; }
      done(await res.json());
      return true;
    } catch (e) {
      console.error('[Order] request failed:', e);
      setError('Network error - check Pending orders and your positions before trying again');
      return false;
    } finally {
      setTimeout(() => { busy.current.delete(key); if (buying) setPlacing(false); }, CLICK_COOLDOWN_MS);
    }
  };

  const boughtReply = (reply: any) => {
    const results: Array<{ ok: boolean; broker: string; tsym?: string; quantity?: number; limitPrice?: number; error?: string }> = reply?.results ?? [];
    for (const r of results) {
      if (r.ok) addNotice(r.error ? 'warning' : 'info', `Limit buy of ${r.quantity} ${r.tsym} at ${rupees(r.limitPrice ?? 0)} placed on ${r.broker.toUpperCase()}. It stays under Pending orders until it fills.${r.error ? ` ${describeError(r.error)}` : ''}`);
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) setError(`Not placed on ${failed.map((r) => `${r.broker}: ${describeError(r.error ?? '')}`).join('; ')}`);
  };

  const buyFlash = (right: 'call' | 'put', shown: PricedContract) =>
    send('buy', '/order/buy-locked', { index: shown.contract.split('_')[0], right, strikePrice: shown.strike, token: shown.token, limitPrice: shown.price }, boughtReply);

  const buyContract = (shown: PricedContract, targetPoints?: number, stopLossPoints?: number) =>
    send('buy', '/order/buy-locked', { contract: shown.contract, token: shown.token, limitPrice: shown.price, targetPoints, stopLossPoints }, boughtReply);

  const squareOffAt = (trade: Trade, shownPrice: number) =>
    send(`sell:${trade.broker}:${trade.token}`, '/order/squareoff-locked', { token: String(trade.token), broker: trade.broker, price: shownPrice, qty: trade.quantity }, (reply) => {
      for (const r of reply?.results ?? []) {
        if (!r.ok) setError(describeError(r.error ?? 'Square off failed'));
        else if (r.closed) addNotice('info', `${r.tsym} was already closed - nothing to sell.`);
        else addNotice(r.error ? 'warning' : 'info', `Limit sell of ${r.quantity} ${r.tsym} at ${rupees(r.limitPrice)} placed. The position stays open until it fills.${r.error ? ` ${r.error}` : ''}`);
      }
    });

  const cancelOrder = async (order: PendingOrder) => {
    await send(`cancel:${order.broker}:${order.orderId}`, '/order/cancel', { broker: order.broker, orderId: order.orderId }, (reply) => {
      if (reply?.status === 'cancelled') setPending((prev) => prev.filter((o) => o.orderId !== order.orderId || o.broker !== order.broker));
      else if (reply?.status === 'filled') addNotice('warning', `${order.tsym}: ${reply.filledQuantity} had already filled before the cancel.`);
      else addNotice('warning', `${order.tsym}: cancel sent, waiting for the broker to confirm.`);
    });
  };

  const dismissNotice = useCallback((id: string) => setNotices((prev) => prev.filter((n) => n.id !== id)), []);

  if (!active) return undefined;
  return { flash, searchQuote, setSearchContract, positionPrice, pending, notices, dismissNotice, buyFlash, buyContract, squareOffAt, cancelOrder };
}
