// NIFTY cash/options market hours: 09:15-15:30 IST. Uses Intl instead of a
// timezone library so it reads correctly regardless of the visitor's own
// timezone.
export function isMarketHours(): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  const minutesSinceMidnight = hour * 60 + minute;

  return minutesSinceMidnight >= 9 * 60 + 15 && minutesSinceMidnight < 15 * 60 + 30;
}
