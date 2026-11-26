import { useEffect, useState } from 'react';
import { Button, ButtonGroup } from 'react-bootstrap';
import type { PageIndex } from '../context/useLockedOrders';
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
// `index` / `onSelect`: the trading page shows NIFTY or SENSEX and switches between them here.
export default function NiftyTicker({ url, feed = false, enabled = true, index = 'NIFTY', onSelect }: { url?: string; feed?: boolean; enabled?: boolean; index?: PageIndex; onSelect?: (index: PageIndex) => void }) {
  const streamUrl = url ?? (index === 'SENSEX' ? '/niftystream/sensex' : '/niftystream');
  // The quote carries its index: after a switch the old index's value is never shown under the new label.
  const [state, setState] = useState<{ index: PageIndex; quote: NiftyQuote } | null>(null);
  const quote = state && state.index === index ? state.quote : null;

  useEffect(() => {
    if (!feed) return;
    let cancelled = false;
    let off: (() => void) | null = null;
    demoFeed.load()
      .then(() => { if (!cancelled) off = demoFeed.subscribe({ nifty: (n) => setState({ index: 'NIFTY', quote: { ...n, open: 0, high: 0, low: 0 } }) }); })
      .catch((err) => console.error('[NiftyTicker] demo data failed to load:', err));
    return () => { cancelled = true; off?.(); };
  }, [feed]);

  useEventSource(streamUrl, {
    enabled: enabled && !feed,
    // The anonymous demo copy has no session to probe.
    authProbeUrl: streamUrl.startsWith('/demo/') ? null : '/auth/me',
    onMessage: (e) => {
      try {
        const data = JSON.parse(e.data);
        if (index === 'SENSEX') {
          const s = data.sensex;
          if (!s) return;
          const ltp = Number(s.ltp);
          // The SENSEX feed carries the day's change in percent only.
          const pct = Number(s.changePercent);
          const change = Number.isFinite(pct) ? ltp - ltp / (1 + pct / 100) : NaN;
          setState({ index: 'SENSEX', quote: { ltp, ltt: s.ltt, open: 0, high: 0, low: 0, change, changePercent: pct } });
          return;
        }
        setState({ index: 'NIFTY', quote: data.nifty ?? data });
      } catch (err) {
        console.error('[NiftyTicker] bad stream message:', err);
      }
    },
  });

  const label = index === 'SENSEX' ? 'SENSEX' : 'NIFTY 50';
  const switcher = onSelect && (
    <ButtonGroup size="sm" aria-label="Index to trade">
      {(['NIFTY', 'SENSEX'] as const).map((i) => (
        <Button key={i} variant={i === index ? 'primary' : 'outline-secondary'} aria-pressed={i === index} className="ticker-switch" onClick={() => onSelect(i)}>
          {i}
        </Button>
      ))}
    </ButtonGroup>
  );

  if (!quote) {
    return (
      <div className="nifty-ticker">
        {switcher}
        <span className="ticker-loading">{label} —</span>
      </div>
    );
  }

  const ltp = Number(quote.ltp) || 0;
  const hasChange = Number.isFinite(Number(quote.change));
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
      return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    }
    return String(ltt).slice(0, 5); // take "HH:MM" from "HH:MM:SS"
  };

  return (
    <div className="nifty-ticker">
      {switcher || <span className="ticker-label">{label}</span>}
      <span className={`ticker-ltp ${colorClass}`}>{ltp.toFixed(2)}</span>
      {hasChange && <span className={`ticker-change ${colorClass}`}>{arrow} {isUp ? '+' : ''}{change.toFixed(2)}</span>}
      {hasChange && <span className={`ticker-pct ${colorClass}`}>({isUp ? '+' : ''}{changePct}%)</span>}
      <span className="ticker-time">{formatTime(quote.ltt)}</span>
    </div>
  );
}
