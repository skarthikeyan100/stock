export interface ExpiryChoice {
  label: string;
  date: string;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "NIFTY 23rd NOV 25400 CE" -> 2026-11-23 (next occurrence on/after today); "25th JAN27" -> 2027-01-25. */
export function parseExpiryLabel(label: string, today: string): string | null {
  const m = label.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]{3})(\d{2})?\b/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toUpperCase());
  if (month < 0) return null;
  const day = parseInt(m[1], 10);
  if (m[3]) return iso(2000 + parseInt(m[3], 10), month, day);
  const year = parseInt(today.slice(0, 4), 10);
  const thisYear = iso(year, month, day);
  return thisYear >= today ? thisYear : iso(year + 1, month, day);
}

function dated(labels: string[], today: string): ExpiryChoice[] {
  const out: ExpiryChoice[] = [];
  for (const label of labels) {
    const date = parseExpiryLabel(label, today);
    if (date && date >= today) out.push({ label, date });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function nearestExpiry(labels: string[], today: string): ExpiryChoice | null {
  return dated(labels, today)[0] ?? null;
}

export function findExpiry(labels: string[], date: string, today: string): ExpiryChoice | null {
  return dated(labels, today).find((e) => e.date === date) ?? null;
}
