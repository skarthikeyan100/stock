// One minute of data as written by scripts/buildData.mjs.
export interface MinuteRow {
  t: string; // "YYYY-MM-DD HH:MM"
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  ceOi: number | null;
  peOi: number | null;
  pcr: number | null;
  contracts: number | null;
}

export interface DayFile {
  day: string;
  rows: MinuteRow[];
}

export interface DaySummary {
  day: string;
  minutes: number;
  pcrMinutes: number;
  niftyMinutes: number;
  avgContracts: number;
}

// One plotted point after bucketing.
export interface Bucket {
  label: string; // bucket start "HH:MM"
  endLabel: string; // bucket end "HH:MM"
  pcr: number | null;
  contracts: number | null;
  close: number | null;
  change: number | null; // points vs previous bucket's close (day open for the first)
  changePct: number | null;
}
