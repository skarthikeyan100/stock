import { useEffect, useState } from 'react';

/**
 * True when the trading server answered /demo/health once, at page load. The static site is hosted separately (Cloudflare Pages), so the
 * page can load while `npm run processes` is down; Google sign-in is only offered when the server can take it. No polling: a user who
 * finds sign-in missing refreshes the page. A non-JSON 200 (a static host's index.html fallback) or any 5xx/network error is "down".
 */
export function useServerReachable(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    fetch('/demo/health', { credentials: 'include', signal: ctrl.signal, cache: 'no-store' })
      .then((res) => { if (alive) setUp(res.ok && (res.headers.get('content-type') || '').includes('json')); })
      .catch(() => { if (alive) setUp(false); })
      .finally(() => clearTimeout(t));
    return () => { alive = false; ctrl.abort(); };
  }, []);
  return up;
}
