import type { Bucket, BuildupCounts, MinuteRow } from './types';

// Contracts reading bullish for NIFTY minus contracts reading bearish. A call's long buildup or
// short covering is bullish and its short buildup or long unwinding bearish; for a put it is the
// reverse (puts gain when NIFTY falls).
export function buildupBias(b: BuildupCounts): number | null {
  const { CE, PE } = b;
  const total = Object.values(CE).reduce((a, v) => a + v, 0) + Object.values(PE).reduce((a, v) => a + v, 0);
  if (total === 0) return null;
  return (
    CE['Long buildup'] + CE['Short covering'] + PE['Short buildup'] + PE['Long unwinding'] -
    (CE['Short buildup'] + CE['Long unwinding'] + PE['Long buildup'] + PE['Short covering'])
  );
}

const minuteOfDay = (t: string) => {
  const [h, m] = t.slice(11, 16).split(':').map(Number);
  return h * 60 + m;
};
const hhmm = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// Groups 1-minute rows into buckets of `size` minutes aligned to clock multiples of `size`
// (e.g. 10m buckets start at 09:10, 09:20, ...). PCR is the last valid value in the bucket; the
// Nifty change is the bucket's last close minus the previous bucket's last close.
export function aggregate(rows: MinuteRow[], size: number): Bucket[] {
  const groups = new Map<number, MinuteRow[]>();
  for (const r of rows) {
    const key = Math.floor(minuteOfDay(r.t) / size) * size;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const keys = [...groups.keys()].sort((a, b) => a - b);
  const buckets: Bucket[] = [];
  // Day open = first non-null open, used as the baseline for the first bucket.
  let prevClose: number | null = rows.find((r) => r.open !== null)?.open ?? null;

  for (const key of keys) {
    const g = groups.get(key)!;
    const withPcr = g.filter((r) => r.pcr !== null);
    const last = withPcr[withPcr.length - 1];
    const closeRow = [...g].reverse().find((r) => r.close !== null) ?? null;
    const close = closeRow?.close ?? null;

    const change = close !== null && prevClose !== null ? close - prevClose : null;
    const changePct = change !== null && prevClose ? (change / prevClose) * 100 : null;

    buckets.push({
      label: hhmm(key),
      endLabel: hhmm(key + size - 1),
      pcr: last?.pcr ?? null,
      contracts: last?.contracts ?? null,
      close,
      change,
      changePct,
      buildup: last?.buildup ?? null,
      bias: last?.buildup ? buildupBias(last.buildup) : null,
    });
    if (close !== null) prevClose = close;
  }
  return buckets;
}
