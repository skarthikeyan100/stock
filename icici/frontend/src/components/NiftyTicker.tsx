import { useEffect, useRef, useState } from 'react';

interface NiftyQuote {
  ltp: number;
  ltt: string;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
}

export default function NiftyTicker() {
  const [quote, setQuote] = useState<NiftyQuote | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let failCount = 0;
    const connect = () => {
      if (esRef.current) esRef.current.close();
      const es = new EventSource('/niftystream');
      esRef.current = es;
      es.onopen = () => { failCount = 0; };
      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setQuote(data.nifty ?? data);
      };
      es.onerror = () => {
        es.close();
        failCount++;
        if (failCount < 3) setTimeout(connect, 3000);
      };
    };
    connect();
    return () => { esRef.current?.close(); };
  }, []);

  if (!quote) {
    return (
      <div className="nifty-ticker">
        <span className="ticker-loading">NIFTY —</span>
      </div>
    );
  }

  const ltp = Number(quote.ltp) || 0;
  const prevClose = Number(quote.prevClose) || 0;
  const change = Number(quote.change) || (prevClose ? ltp - prevClose : 0);
  const changePct = prevClose ? ((change / prevClose) * 100).toFixed(2) : '0.00';
  const isUp = change >= 0;
  const colorClass = isUp ? 'ticker-up' : 'ticker-down';
  const arrow = isUp ? '▲' : '▼';

  // ltt can be epoch seconds (e.g. "1740123456") or "HH:MM:SS" — format to HH:MM
  const formatTime = (ltt: string): string => {
    const n = Number(ltt);
    if (!isNaN(n) && n > 1000000) {
      const d = new Date(n * 1000);
      return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return String(ltt).slice(0, 5); // take "HH:MM" from "HH:MM:SS"
  };

  return (
    <div className="nifty-ticker">
      <span className="ticker-label">NIFTY 50</span>
      <span className={`ticker-ltp ${colorClass}`}>{ltp.toFixed(2)}</span>
      <span className={`ticker-change ${colorClass}`}>{arrow} {isUp ? '+' : ''}{change.toFixed(2)}</span>
      <span className={`ticker-pct ${colorClass}`}>({isUp ? '+' : ''}{changePct}%)</span>
      <span className="ticker-time">{formatTime(quote.ltt)}</span>
    </div>
  );
}
