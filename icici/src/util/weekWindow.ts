// Trading-week boundary: Wednesday 00:00 through Tuesday 23:59:59.999, using
// server-local Date methods (matching bookkeeping.ts's startOfDay() convention)
// rather than UTC - a UTC boundary would be wrong for IST users near midnight,
// same reasoning already applied in frontend/src/components/DateRangeFilter.tsx.
const WEEK_START_DAY = 3; // Date#getDay(): 0=Sun..6=Sat, 3=Wed

export function startOfWeek(reference: Date = new Date()): Date {
    const d = new Date(reference);
    const diff = (d.getDay() - WEEK_START_DAY + 7) % 7;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

export function endOfWeek(reference: Date = new Date()): Date {
    const start = startOfWeek(reference);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return end;
}

// 'YYYY-MM-DD' of the reference date's week-start (Wednesday) - stable
// grouping key for bucketing trades by week.
export function weekKey(reference: Date): string {
    const start = startOfWeek(reference);
    const y = start.getFullYear();
    const m = String(start.getMonth() + 1).padStart(2, '0');
    const day = String(start.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
