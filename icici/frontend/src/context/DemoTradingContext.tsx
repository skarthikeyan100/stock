import { useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Trade, TradingContext } from './TradingContext';

// In-memory demo trading state - no auth, no real orders, no /positionstream.
// Feeds the SAME TradingContext object TradingContext.tsx creates (not a
// separate context) so OrderEntry/PositionCard - which hardcode
// `useTrading` from '../context/TradingContext' - work unchanged under
// whichever provider (real or demo) is actually mounted.
//
// Contract resolution goes through /demo/resolve and /demo/symbols (ANT-
// native tokens), never /search or /quote (Shoonya/Zerodha-based) - ANT is
// the sole live-tick source (src/processes/dataProcess.ts), and a Zerodha
// instrument token can't be subscribed on it. See AntContractMaster.ts's
// "must never be stored as trade.token" warning.

const maxLoss = 15000;
const lotLimit = 10;
const NIFTY_LOT_SIZE = 65;

interface PendingPoints {
  targetPoints?: number;
  stopLossPoints?: number;
}

export function DemoTradingProvider({ children }: { children: ReactNode }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `trades` synchronously so the long-lived SSE handler below never
  // reads a stale closure of state (it's created once, deps: []).
  const tradesRef = useRef<Trade[]>([]);
  // Tokens the demo currently cares about (pending or open), so the shared
  // /optionstream broadcast can be filtered without re-subscribing per tick.
  const watchedTokensRef = useRef<Set<string>>(new Set());
  // Target/SL points requested at Buy time, applied once the pending trade
  // actually fills (there's no reference price to compute an absolute
  // target/stop-loss price from until the first live tick arrives).
  const pendingPointsRef = useRef<Map<string, PendingPoints>>(new Map());

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

  const unsubscribeToken = (token: string) => {
    watchedTokensRef.current.delete(token);
    fetch(`/demo/subscribe?token=${encodeURIComponent(token)}&subscribe=false`).catch((e) =>
      console.error('[Demo] unsubscribe failed:', e)
    );
  };

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
        const points = pendingPointsRef.current.get(token);
        pendingPointsRef.current.delete(token);
        next = {
          ...t,
          status: 'open',
          price: ltp,
          lastTradePrice: ltp,
          targetPrice: points?.targetPoints ? ltp + points.targetPoints : undefined,
          stopLossPrice: points?.stopLossPoints ? ltp - points.stopLossPoints : undefined,
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
      unsubscribeToken(hit.token);
      setClosedTrades((prev) => [...prev, { ...hit, open: false, realizedPnL: (ltp - hit.price) * hit.quantity }]);
    }
  }, [applyTrades]);

  // Shared /optionstream connection - same reconnect-with-backoff pattern used
  // elsewhere (NiftyTicker, TradingContext's positionstream), matches ticks
  // against whichever tokens the demo currently has pending/open.
  useEffect(() => {
    let failCount = 0;

    const connectSSE = () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      const es = new EventSource('/optionstream');
      esRef.current = es;

      es.onopen = () => {
        failCount = 0;
      };

      es.onmessage = (event) => {
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
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        failCount++;
        const delay = Math.min(3000 * 2 ** (failCount - 1), 30000);
        reconnectTimerRef.current = setTimeout(connectSSE, delay);
      };
    };

    connectSSE();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (esRef.current) esRef.current.close();
      esRef.current = null;
    };
  }, [handleTick]);

  // Starts a pending demo trade with no price yet - PositionCard already
  // renders "Waiting for price..." until lastTradePrice is set, which happens
  // on the first live ANT tick (handleTick). There is no earlier "displayed"
  // price to treat as a reference, since the token wasn't subscribed before.
  const startPendingTrade = useCallback(
    async (token: string, tradingSymbol: string, right: string, quantity: number, targetPoints?: number, stopLossPoints?: number) => {
      setPlacingOrder(true);
      setOrderError(null);
      try {
        await fetch(`/demo/subscribe?token=${encodeURIComponent(token)}&subscribe=true`);
        watchedTokensRef.current.add(token);
        if (targetPoints || stopLossPoints) {
          pendingPointsRef.current.set(token, { targetPoints, stopLossPoints });
        }

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
      } catch (err) {
        console.error('[Demo] Order failed:', err);
        setOrderError('Failed to place demo order');
      } finally {
        setPlacingOrder(false);
      }
    },
    [applyTrades]
  );

  const placeOrder = useCallback(
    async (right: string) => {
      try {
        const res = await fetch(`/demo/resolve?right=${right}`);
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
  // a bare Zerodha tsym like the real OrderEntry passes.
  const placeContractOrder = useCallback(
    async (contract: string, targetPoints?: number, stopLossPoints?: number) => {
      const [token, tradingSymbol, optionType] = contract.split('|');
      const right = optionType === 'PE' ? 'put' : 'call';
      await startPendingTrade(token, tradingSymbol, right, NIFTY_LOT_SIZE, targetPoints, stopLossPoints);
    },
    [startPendingTrade]
  );

  // PositionCard.tsx (shared, unmodified) calls squareOff(trade.tsym, ...) -
  // it passes the human-readable symbol, not the ANT token (unlike
  // setTargetStopLoss, which passes trade.token). That's a no-op distinction
  // for real/Zerodha trades, where tsym === token, but not here - so match on
  // tsym and use the found trade's own .token for the actual unsubscribe.
  const squareOff = useCallback(
    async (tsym: string) => {
      const trade = tradesRef.current.find((t) => t.tsym === tsym);
      if (!trade) return;
      unsubscribeToken(trade.token);
      pendingPointsRef.current.delete(trade.token);
      applyTrades(tradesRef.current.filter((t) => t.tsym !== tsym));
      const exitPrice = trade.lastTradePrice || trade.price;
      setClosedTrades((prev) => [
        ...prev,
        { ...trade, lastTradePrice: exitPrice, open: false, realizedPnL: (exitPrice - trade.price) * trade.quantity },
      ]);
    },
    [applyTrades]
  );

  const setTargetStopLoss = useCallback(
    async (token: string, targetPoints: number, stopLossPoints: number) => {
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
