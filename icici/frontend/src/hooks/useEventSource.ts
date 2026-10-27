import { useEffect, useRef } from 'react';
import { notifyUnauthorized } from '../utils/api';

interface Options {
  /** When false nothing is opened (e.g. no logged-in user yet). Default true. */
  enabled?: boolean;
  onMessage: (event: MessageEvent) => void;
  /** Fires on every (re)connect, e.g. to refetch anything emitted while the stream was down. */
  onOpen?: () => void;
  /** Probe URL checked after a failure to tell "server restarting" from "session gone". Default '/auth/me'; null disables. */
  authProbeUrl?: string | null;
}

const BASE_DELAY_MS = 3000;
const MAX_DELAY_MS = 30000;

/**
 * One EventSource with the reconnect behaviour every stream here needs: capped exponential backoff WITH jitter (so clients do not
 * reconnect in lockstep after a restart), a disposed guard (an unmount during backoff must not open an orphan stream), and a 401
 * probe (EventSource hides the HTTP status, so after a failure the session is checked once; if it is gone the app drops to the login
 * screen and the stream stays closed instead of retrying forever).
 */
export function useEventSource(url: string, { enabled = true, onMessage, onOpen, authProbeUrl = '/auth/me' }: Options): void {
  // Latest callbacks without re-opening the stream on every render.
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  onMessageRef.current = onMessage;
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let failCount = 0;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      es?.close();
      es = new EventSource(url);
      es.onopen = () => {
        failCount = 0;
        onOpenRef.current?.();
      };
      es.onmessage = (e) => onMessageRef.current(e);
      es.onerror = () => {
        es?.close();
        es = null;
        if (disposed) return;
        failCount++;
        const base = Math.min(BASE_DELAY_MS * 2 ** (failCount - 1), MAX_DELAY_MS);
        const retry = () => {
          if (!disposed) timer = setTimeout(connect, base * (0.75 + Math.random() * 0.5));
        };
        if (!authProbeUrl) { retry(); return; }
        fetch(authProbeUrl, { credentials: 'include' })
          .then((res) => {
            if (res.status === 401) { notifyUnauthorized(); return; } // session gone: stop, the login screen takes over
            retry();
          })
          .catch(retry); // network down: keep trying
      };
    };
    connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [url, enabled, authProbeUrl]);
}
