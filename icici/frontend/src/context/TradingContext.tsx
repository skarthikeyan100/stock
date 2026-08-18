import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useAuth } from './AuthContext';

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
}

interface TradingState {
  trades: Trade[];
  closedTrades: Trade[];
  openPnL: number;
  totalPnL: number;
  usedAmount: number;
  placingOrder: boolean;
  isOrderDisabled: boolean;
  orderError: string | null;
  placeOrder: (right: string) => Promise<void>;
  placeContractOrder: (contract: string) => Promise<void>;
  squareOff: (token: string, qty: number) => Promise<void>;
  setTargetStopLoss: (token: string, targetPoints: number, stopLossPoints: number) => Promise<void>;
  clearError: () => void;
}

const TradingContext = createContext<TradingState | null>(null);

export function TradingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const maxLoss = user?.lossLimit ?? 15000;
  const lotLimit = user?.lotCount ?? 10;
  const [trades, setTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    return 65;
  };
  const tradedLots = trades.reduce((sum, t) => sum + Math.ceil(t.quantity / getInstrumentLotSize(t.tsym)), 0);
  const isOrderDisabled = tradedLots >= lotLimit || totalPnL <= -maxLoss || placingOrder;

  // SSE: Position stream — connects only after user is authenticated, stops after 3 failures
  useEffect(() => {
    if (!user) return;
    let failCount = 0;

    const connectSSE = () => {
      // Close any existing connection before opening a new one
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      console.log('[SSE] Establishing position stream connection...');
      const es = new EventSource('/positionstream');
      esRef.current = es;

      es.onopen = () => {
        console.log('[SSE] Position stream connected');
        failCount = 0;
      };

      es.onmessage = (event) => {
        try {
          const allTrades: Trade[] = JSON.parse(event.data);
          if (!Array.isArray(allTrades)) return;

          setTrades(allTrades.filter(t => t.open !== false));
          setClosedTrades(allTrades.filter(t => t.open === false));
        } catch (e) {
          console.error('[SSE] Position stream parse error:', e);
        }
      };

      es.onerror = () => {
        console.error('[SSE] Position stream error, readyState:', es.readyState);
        es.close();
        esRef.current = null;
        failCount++;
        if (failCount >= 3) {
          console.error('[SSE] Position stream failed 3 times, giving up. Refresh the page to retry.');
          return;
        }
        reconnectTimerRef.current = setTimeout(connectSSE, 3000);
      };
    };

    connectSSE();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        console.log('[SSE] Closing position stream connection');
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [user]);

  const placeOrder = useCallback(async (right: string) => {
    setPlacingOrder(true);
    setOrderError(null);
    try {
      const response = await fetch(
        `/prism/order/buy?index=NIFTY&right=${right}`,
        { headers: { 'X-User-Id': user?.email || 'Default' } }
      );
      if (!response.ok) {
        const body = await response.json();
        setOrderError(body.message || 'Order rejected');
      }
    } catch (err) {
      console.error('[Order] Order failed:', err);
      setOrderError('Network error');
    } finally {
      setPlacingOrder(false);
    }
  }, [user?.email]);

  const placeContractOrder = useCallback(async (contract: string) => {
    setPlacingOrder(true);
    setOrderError(null);
    try {
      const response = await fetch(
        `/prism/order/buy?contract=${encodeURIComponent(contract)}`,
        { headers: { 'X-User-Id': user?.email || 'Default' } }
      );
      if (!response.ok) {
        const body = await response.json();
        setOrderError(body.message || 'Order rejected');
      }
    } catch (err) {
      console.error('[Order] Contract order failed:', err);
      setOrderError('Network error');
    } finally {
      setPlacingOrder(false);
    }
  }, [user?.email]);

  const squareOff = useCallback(async (token: string, qty: number) => {
    try {
      await fetch(
        `/prism/squareoff?token=${encodeURIComponent(token)}&qty=${qty}`,
        { headers: { 'X-User-Id': user?.email || 'Default' } }
      );
    } catch (err) {
      console.error('[SquareOff] Square off failed:', err);
    }
  }, [user?.email]);

  const setTargetStopLoss = useCallback(async (token: string, targetPoints: number, stopLossPoints: number) => {
    try {
      await fetch('/prism/settarget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, targetPoints, stopLossPoints }),
      });
    } catch (err) {
      console.error('[SetTarget] Failed:', err);
    }
  }, []);

  const clearError = useCallback(() => setOrderError(null), []);

  return (
    <TradingContext.Provider value={{ trades, closedTrades, openPnL, totalPnL, usedAmount, placingOrder, isOrderDisabled, orderError, placeOrder, placeContractOrder, squareOff, setTargetStopLoss, clearError }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTrading must be used within TradingProvider');
  return ctx;
}
