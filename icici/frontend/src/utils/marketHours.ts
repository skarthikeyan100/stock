import { useEffect, useState } from 'react';

// NIFTY cash/options market hours: Mon-Fri 09:15-15:30 IST. Uses Intl instead of a
// timezone library so it reads correctly regardless of the visitor's own
// timezone. (Exchange holidays are not known here - the server stays the authority.)
export function isMarketHours(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find(p => p.type === 'weekday')?.value;
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = Number(parts.find(p => p.type === 'hour')?.value) % 24; // some engines print midnight as 24
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  const minutesSinceMidnight = hour * 60 + minute;

  return minutesSinceMidnight >= 9 * 60 + 15 && minutesSinceMidnight < 15 * 60 + 30;
}

// Re-evaluates every 30s so buttons enable at 09:15 and disable at 15:30 without needing an unrelated re-render.
export function useMarketHours(): boolean {
  const [open, setOpen] = useState(isMarketHours());
  useEffect(() => {
    const id = setInterval(() => setOpen(isMarketHours()), 30_000);
    return () => clearInterval(id);
  }, []);
  return open;
}
