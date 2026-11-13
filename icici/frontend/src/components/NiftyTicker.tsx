import { useEffect, useState } from 'react';
import { useEventSource } from '../hooks/useEventSource';
import { demoFeed } from '../demo/demoFeed';

interface NiftyQuote {
  ltp: number;
  ltt: string;
  open: number;
  high: number;
  low: number;
  change: number;
  changePercent: number;
}

// `url` defaults to the authenticated stream; the logged-out demo page passes its anonymous copy. `feed` makes the demo page take the
// recorded day replayed in the browser instead (no stream at all); `enabled` = false opens nothing (demo still choosing its source).
export default function NiftyTicker({ url = '/niftystream', feed = false, enabled = true }: { url?: string; feed?: boolean; enabled?: boolean }) {
  const [quote, setQuote] = useState<NiftyQuote | null>(null);

  useEffect(() => {
    if (!feed) return;
    let cancelled = false;
    let off: (() => void) | null = null;
    demoFeed.load()
      .then(() => { if (!cancelled) off = demoFeed.subscribe({ nifty: (n) => setQuote({ ...n, open: 0, high: 0, low: 0 }) }); })
      .catch((err) => console.error('[NiftyTicker] demo data failed to load:', err));
    return () => { cancelled = true; off?.(); };
  }, [feed]);

  useEventSource(url, {
    enabled: enabled && !feed,
    // The anonymous demo copy has no session to probe.
    authProbeUrl: url.startsWith('/demo/') ? null : '/auth/me',
    onMessage: (e) => {
      try {
        const data = JSON.parse(e.data);
        setQuote(data.nifty ?? data);
      } catch (err) {
        console.error('[NiftyTicker] bad stream message:', err);
      }
    },
  });

  if (!quote) {
    return (
      <div className="nifty-ticker">
        <span className="ticker-loading">NIFTY —</span>
      </div>
    );
  }

  const ltp = Number(quote.ltp) || 0;
  const change = Number(quote.change) || 0;
  const changePct = (Number(quote.changePercent) || 0).toFixed(2);
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
