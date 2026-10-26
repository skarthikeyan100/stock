// Single source of truth for the "local calendar day" key used by every strategy's
// once-per-day latch (YYYY-MM-DD in the server's local time zone, i.e. IST in production).
export function localDayKey(date: Date = new Date()): string {
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${m}-${d}`;
}
