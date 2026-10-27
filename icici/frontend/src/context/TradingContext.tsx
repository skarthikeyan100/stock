import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useEventSource } from '../hooks/useEventSource';
import { useMarketHours } from '../utils/marketHours';
import { apiPost, readError, apiFetch } from '../utils/api';

export interface Trade {
  tsym: string;
  token: string;
  right: string;
  action: string;
  quantity: number;
  price: number;
  lastTradePrice: number;
  user: string;
  status: string;
  open?: boolean;
  realizedPnL?: number;
  targetPrice?: number;
  stopLossPrice?: number;
  // Demo-only: target/SL points requested at Buy time, before there's a live
  // price to resolve them to an absolute targetPrice/stopLossPrice against
  // (see DemoTradingContext's pendingPointsRef). Lets a still-pending
  // position show what was requested instead of looking like nothing was set.
  pendingTargetPoints?: number;
  pendingStopLossPoints?: number;
}

interface TradingState {
  trades: Trade[];
  closedTrades: Trade[];
  openPnL: number;
  totalPnL: number;
  usedAmount: number;
  placingOrder: boolean;
  isOrderDisabled: boolean;
  tradingBlocked: boolean;
  blockReason: string | null;
  orderError: string | null;
  placeOrder: (right: string) => Promise<void>;
  // Resolve true only when the server accepted the request, so callers clear their inputs/selection on success only.
  placeContractOrder: (contract: string, targetPoints?: number, stopLossPoints?: number) => Promise<boolean>;
  squareOff: (token: string, qty: number) => Promise<boolean>;
  setTargetStopLoss: (token: string, targetPoints: number, stopLossPoints: number) => Promise<boolean>;
  clearError: () => void;
}

// Exported (not just the Provider) so DemoTradingProvider can feed the same
// context with an in-memory implementation - OrderEntry/PositionCard import
// useTrading() from this module regardless of which provider is mounted.
export const TradingContext = createContext<TradingState | null>(null);

export function TradingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const maxLoss = user?.lossLimit ?? 15000;
  const lotLimit = user?.lotCount ?? 10;
  const [trades, setTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [tradingBlocked, setTradingBlocked] = useState(false);
  const [blockReason, setBlockReason] = useState<string | null>(null);

  const openPnL = trades.reduce((sum, trade) => {
    if (trade.lastTradePrice && trade.price) {
      return sum + (trade.lastTradePrice - trade.price) * trade.quantity;
    }
    return sum;
  }, 0);

  const closedPnL = closedTrades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
  const totalPnL = openPnL + closedPnL;
  const usedAmount = trades.reduce((sum, t) => sum + t.price * t.quantity, 0);

  const getInstrumentLotSize = (tsym: string): number => {
    if (tsym.startsWith('BANKNIFTY')) return 15;
    if (tsym.startsWith('FINNIFTY')) return 25;
    if (tsym.startsWith('SENSEX')) return 20;
    return 65;
  };
  const tradedLots = trades.reduce((sum, t) => sum + Math.ceil(t.quantity / getInstrumentLotSize(t.tsym)), 0);
  const marketOpen = useMarketHours();
  const isOrderDisabled = tradedLots >= lotLimit || totalPnL <= -maxLoss || placingOrder || !marketOpen;

  // SSE: Position stream — connects only after user is authenticated, retries
  // indefinitely with a capped exponential backoff (never gives up: a live
  // trading dashboard must keep trying to reconnect, since giving up leaves
  // P&L/positions frozen with no indication anything is wrong until a manual
  // page refresh - confirmed live on 2026-08-26 after a burst of backend
  // restarts tripped the old "give up after 3 failures" limit).
  useEventSource('/positionstream', {
    enabled: !!user,
    onOpen: () => console.log('[SSE] Position stream connected'),
    onMessage: (event) => {
      try {
        const allTrades: Trade[] = JSON.parse(event.data);
        if (!Array.isArray(allTrades)) return;

        setTrades(allTrades.filter(t => t.open !== false));
        setClosedTrades(allTrades.filter(t => t.open === false));
      } catch (e) {
        console.error('[SSE] Position stream parse error:', e);
      }
    },
  });

  // Polls the real daily/weekly-drawdown check (src/processes/order/bookkeeping.ts's
  // canPlaceOrder) rather than relying on the client-side lossLimit heuristic
  // above, which doesn't know about the 25% daily / 50% weekly rules.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const check = () => {
      apiFetch('/prism/canPlaceOrder')
        .then(res => {
          // A 401/500 says nothing about the trading rules: keep the last known state instead of flipping to "blocked".
          if (!res.ok) throw new Error(`canPlaceOrder ${res.status}`);
          return res.json();
        })
        .then((data: { allowed: boolean; reason?: string }) => {
          if (cancelled) return;
          setTradingBlocked(!data.allowed);
          setBlockReason(data.reason ?? null);
        })
        .catch(() => {});
    };

    check();
    const interval = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.email]);

  const describeOrderError = (body: any): string => {
    // Backend sends { error: string }, not { message: string } - read the
    // field it actually sends. Kite's raw insufficient-funds message
    // ("ageing debit balance ... collateral margin ...") is accurate but not
    // user-friendly, so it's mapped to a plain-language equivalent.
    const message: string = body?.error || body?.message || '';
    if (/debit balance|collateral margin/i.test(message)) {
      return 'Order rejected as funds are not available';
    }
    return message || 'Order rejected';
  };

  const placeOrder = useCallback(async (right: string) => {
    setPlacingOrder(true);
    setOrderError(null);
    try {
      const response = await apiPost(`/order/buy?index=NIFTY&right=${encodeURIComponent(right)}`);
      if (!response.ok) {
        setOrderError(describeOrderError({ error: await readError(response) }));
      }
    } catch (err) {
      console.error('[Order] Order failed:', err);
      setOrderError('Network error');
    } finally {
      setPlacingOrder(false);
    }
  }, []);

  const placeContractOrder = useCallback(async (contract: string, targetPoints?: number, stopLossPoints?: number): Promise<boolean> => {
    setPlacingOrder(true);
    setOrderError(null);
    try {
      const params = new URLSearchParams({ contract });
      if (targetPoints !== undefined) params.set('targetPoints', String(targetPoints));
      if (stopLossPoints !== undefined) params.set('stopLossPoints', String(stopLossPoints));
      const response = await apiPost(`/order/buy?${params.toString()}`);
      if (!response.ok) {
        setOrderError(describeOrderError({ error: await readError(response) }));
        return false;
      }
      return true;
    } catch (err) {
      console.error('[Order] Contract order failed:', err);
      setOrderError('Network error');
      return false;
    } finally {
      setPlacingOrder(false);
    }
  }, []);

  const squareOff = useCallback(async (token: string, qty: number): Promise<boolean> => {
    setOrderError(null);
    try {
      const response = await apiPost(`/order/squareoff?token=${encodeURIComponent(token)}&qty=${qty}`);
      if (!response.ok) {
        // The server answers with plain text on some failures: read it as text, not JSON.
        setOrderError(describeOrderError({ error: await readError(response) }));
        return false;
      }
      return true;
    } catch (err) {
      console.error('[SquareOff] Square off failed:', err);
      setOrderError('Network error');
      return false;
    }
  }, []);

  const setTargetStopLoss = useCallback(async (token: string, targetPoints: number, stopLossPoints: number): Promise<boolean> => {
    try {
      const response = await apiPost('/order/settarget', { token, targetPoints, stopLossPoints });
      if (!response.ok) {
        setOrderError(await readError(response));
        return false;
      }
      return true;
    } catch (err) {
      console.error('[SetTarget] Failed:', err);
      setOrderError('Network error');
      return false;
    }
  }, []);

  const clearError = useCallback(() => setOrderError(null), []);

  return (
    <TradingContext.Provider value={{ trades, closedTrades, openPnL, totalPnL, usedAmount, placingOrder, isOrderDisabled, tradingBlocked, blockReason, orderError, placeOrder, placeContractOrder, squareOff, setTargetStopLoss, clearError }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTrading must be used within TradingProvider');
  return ctx;
}
