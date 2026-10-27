import { useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Trade, TradingContext } from './TradingContext';
import { apiFetch } from '../utils/api';
import { useEventSource } from '../hooks/useEventSource';

// In-memory demo trading state - no auth, no real orders, no /positionstream.
// Feeds the SAME TradingContext object TradingContext.tsx creates (not a
// separate context) so OrderEntry/PositionCard - which hardcode
// `useTrading` from '../context/TradingContext' - work unchanged under
// whichever provider (real or demo) is actually mounted.
//
// Contract resolution goes through /demo/resolve and /demo/symbols (ANT-
// native tokens), never /search or /quote (Shoonya/Kite-based) - ANT is
// the sole live-tick source (src/processes/dataProcess.ts), and a Kite
// instrument token can't be subscribed on it. See AntContractMaster.ts's
// "must never be stored as trade.token" warning.

const maxLoss = 15000;
const lotLimit = 10;
const NIFTY_LOT_SIZE = 65;

export function DemoTradingProvider({ children }: { children: ReactNode }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  // Mirrors `trades` synchronously so the long-lived SSE handler below never
  // reads a stale closure of state (it's created once, deps: []).
  const tradesRef = useRef<Trade[]>([]);
  // Tokens the demo currently cares about (pending or open), so the shared
  // /optionstream broadcast can be filtered without re-subscribing per tick.
  const watchedTokensRef = useRef<Set<string>>(new Set());
  // Server-side subscriptions are shared per token, so they are ref-counted: two rows on the same contract each hold
  // one, and only the last release actually unsubscribes (closing one row must not freeze the other's LTP).
  const subscriptionCountRef = useRef<Map<string, number>>(new Map());

  const applyTrades = useCallback((next: Trade[]) => {
    tradesRef.current = next;
    setTrades(next);
  }, []);

  const openPnL = trades.reduce((sum, trade) => {
    if (trade.lastTradePrice && trade.price) {
      return sum + (trade.lastTradePrice - trade.price) * trade.quantity;
    }
    return sum;
  }, 0);

  const closedPnL = closedTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
  const totalPnL = openPnL + closedPnL;
  const usedAmount = trades.reduce((sum, t) => sum + t.price * t.quantity, 0);

  const tradedLots = trades.reduce((sum, t) => sum + Math.ceil(t.quantity / NIFTY_LOT_SIZE), 0);
  const isOrderDisabled = tradedLots >= lotLimit || totalPnL <= -maxLoss || placingOrder;

  const releaseToken = (token: string) => {
    const count = subscriptionCountRef.current.get(token) ?? 0;
    if (count <= 1) {
      subscriptionCountRef.current.delete(token);
      watchedTokensRef.current.delete(token);
      apiFetch(`/demo/subscribe?token=${encodeURIComponent(token)}&subscribe=false`).catch((e) =>
        console.error('[Demo] unsubscribe failed:', e)
      );
    } else {
      subscriptionCountRef.current.set(token, count - 1);
    }
  };

  // Leaving the demo (Exit Demo, tab close, route change) must not leave server-side tick subscriptions behind.
  useEffect(() => {
    const counts = subscriptionCountRef.current;
    return () => {
      for (const token of counts.keys()) {
        apiFetch(`/demo/subscribe?token=${encodeURIComponent(token)}&subscribe=false`, { keepalive: true }).catch(() => undefined);
      }
      counts.clear();
    };
  }, []);

  // First matching tick after subscribe fills a pending trade ("price
  // crosses" confirmation) and applies any requested target/SL points as
  // absolute prices; every later tick updates LTP and checks target/stop-
  // loss, mirroring exitMonitor.ts's ltp >= target / ltp <= SL.
  const handleTick = useCallback((token: string, ltp: number) => {
    const hits: Trade[] = [];
    const updated: Trade[] = [];
    for (const t of tradesRef.current) {
      if (t.token !== token) {
        updated.push(t);
        continue;
      }
      let next: Trade;
      if (t.status === 'pending') {
        // Each row carries its own requested points, so two rows on one contract never share/lose them.
        next = {
          ...t,
          status: 'open',
          price: ltp,
          lastTradePrice: ltp,
          targetPrice: t.pendingTargetPoints ? ltp + t.pendingTargetPoints : undefined,
          stopLossPrice: t.pendingStopLossPoints ? ltp - t.pendingStopLossPoints : undefined,
        };
      } else {
        next = { ...t, lastTradePrice: ltp };
      }
      const hitTarget = next.targetPrice != null && ltp >= next.targetPrice;
      const hitStopLoss = next.stopLossPrice != null && ltp <= next.stopLossPrice;
      if (next.status === 'open' && (hitTarget || hitStopLoss)) {
        hits.push(next);
      } else {
        updated.push(next);
      }
    }
    applyTrades(updated);
    for (const hit of hits) {
      releaseToken(hit.token);
      setClosedTrades((prev) => [...prev, { ...hit, open: false, realizedPnL: (ltp - hit.price) * hit.quantity }]);
    }
  }, [applyTrades]);

  // Shared /optionstream connection - same reconnect-with-backoff pattern used
  // elsewhere (NiftyTicker, TradingContext's positionstream), matches ticks
  // against whichever tokens the demo currently has pending/open.
  useEventSource('/demo/optionstream', {
    authProbeUrl: null, // anonymous stream: there is no session to probe
    onMessage: (event) => {
      try {
        const quote = JSON.parse(event.data);
        const token: string = quote.token;
        if (!token || !watchedTokensRef.current.has(token)) return;
        const ltp = Number(quote.ltp);
        if (!ltp) return;
        handleTick(token, ltp);
      } catch (e) {
        console.error('[Demo] optionstream parse error:', e);
      }
    },
  });

  // Starts a pending demo trade with no price yet - PositionCard already
  // renders "Waiting for price..." until lastTradePrice is set, which happens
  // on the first live ANT tick (handleTick). There is no earlier "displayed"
  // price to treat as a reference, since the token wasn't subscribed before.
  const startPendingTrade = useCallback(
    async (token: string, tradingSymbol: string, right: string, quantity: number, targetPoints?: number, stopLossPoints?: number): Promise<boolean> => {
      setPlacingOrder(true);
      setOrderError(null);
      try {
        const sub = await apiFetch(`/demo/subscribe?token=${encodeURIComponent(token)}&subscribe=true`);
        // A rejected subscribe would leave a pending trade waiting for ticks that never come.
        if (!sub.ok) throw new Error(`subscribe failed (${sub.status})`);
        subscriptionCountRef.current.set(token, (subscriptionCountRef.current.get(token) ?? 0) + 1);
        watchedTokensRef.current.add(token);

        const pendingTrade: Trade = {
          tsym: tradingSymbol,
          token,
          right,
          action: 'Buy',
          quantity,
          price: 0,
          lastTradePrice: 0,
          user: 'demo',
          status: 'pending',
          open: true,
          pendingTargetPoints: targetPoints,
          pendingStopLossPoints: stopLossPoints,
        };
        applyTrades([...tradesRef.current, pendingTrade]);
        return true;
      } catch (err) {
        console.error('[Demo] Order failed:', err);
        setOrderError('Failed to place demo order');
        return false;
      } finally {
        setPlacingOrder(false);
      }
    },
    [applyTrades]
  );

  const placeOrder = useCallback(
    async (right: string) => {
      try {
        const res = await apiFetch(`/demo/resolve?right=${encodeURIComponent(right)}`);
        if (!res.ok) throw new Error('Failed to resolve contract');
        const { token, tradingSymbol } = await res.json();
        if (!token) throw new Error('No contract found');
        await startPendingTrade(token, tradingSymbol, right, NIFTY_LOT_SIZE);
      } catch (err) {
        console.error('[Demo] Flash trade failed:', err);
        setOrderError('Failed to place demo order');
      }
    },
    [startPendingTrade]
  );

  // `contract` is a "<token>|<tradingSymbol>|<optionType>" triple produced by
  // DemoOrderEntry's ANT-native symbol picker (see DemoOrderEntry.tsx) - not
  // a bare Kite tsym like the real OrderEntry passes.
  const placeContractOrder = useCallback(
    async (contract: string, targetPoints?: number, stopLossPoints?: number): Promise<boolean> => {
      const [token, tradingSymbol, optionType] = contract.split('|');
      const right = optionType === 'PE' ? 'put' : 'call';
      return startPendingTrade(token, tradingSymbol, right, NIFTY_LOT_SIZE, targetPoints, stopLossPoints);
    },
    [startPendingTrade]
  );

  // Closes ONE row: the first open/pending trade on this token (rows can share a contract), releasing exactly one
  // subscription. Both PositionCard and DemoPositionCard pass the trade's token.
  const squareOff = useCallback(
    async (token: string): Promise<boolean> => {
      const idx = tradesRef.current.findIndex((t) => t.token === token);
      if (idx === -1) return false;
      const trade = tradesRef.current[idx];
      releaseToken(trade.token);
      applyTrades(tradesRef.current.filter((_, i) => i !== idx));
      const exitPrice = trade.lastTradePrice || trade.price;
      setClosedTrades((prev) => [
        ...prev,
        { ...trade, lastTradePrice: exitPrice, open: false, realizedPnL: (exitPrice - trade.price) * trade.quantity },
      ]);
      return true;
    },
    [applyTrades]
  );

  const setTargetStopLoss = useCallback(
    async (token: string, targetPoints: number, stopLossPoints: number): Promise<boolean> => {
      applyTrades(
        tradesRef.current.map((t) =>
          t.token === token
            ? {
                ...t,
                targetPrice: targetPoints > 0 ? t.price + targetPoints : t.targetPrice,
                stopLossPrice: stopLossPoints > 0 ? t.price - stopLossPoints : t.stopLossPrice,
              }
            : t
        )
      );
      return true;
    },
    [applyTrades]
  );

  const clearError = useCallback(() => setOrderError(null), []);

  return (
    <TradingContext.Provider
      value={{
        trades,
        closedTrades,
        openPnL,
        totalPnL,
        usedAmount,
        placingOrder,
        isOrderDisabled,
        tradingBlocked: false,
        blockReason: null,
        orderError,
        placeOrder,
        placeContractOrder,
        squareOff,
        setTargetStopLoss,
        clearError,
      }}
    >
      {children}
    </TradingContext.Provider>
  );
}
