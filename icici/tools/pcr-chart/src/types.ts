// One minute of data as written by scripts/buildData.mjs.
export interface MinuteRow {
  t: string; // "YYYY-MM-DD HH:MM"
  spot: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  ce: number | null;
  pe: number | null;
  pcr: number | null;
  strikes: number;
}

export interface DayFile {
  day: string;
  windowPoints: number;
  maxStaleMin: number;
  rows: MinuteRow[];
}

export interface DaySummary {
  day: string;
  minutes: number;
  pcrMinutes: number;
  niftyMinutes: number;
  avgStrikes: number;
  maxStaleSeen: number;
}

// One plotted point after bucketing.
export interface Bucket {
  label: string; // bucket start "HH:MM"
  endLabel: string; // bucket end "HH:MM"
  pcr: number | null;
  strikes: number | null;
  close: number | null;
  change: number | null; // points vs previous bucket's close (day open for the first)
  changePct: number | null;
}
