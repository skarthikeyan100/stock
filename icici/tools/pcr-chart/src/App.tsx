import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { aggregate } from './aggregate';
import { AXIS_W, Chart, PAD } from './Chart';
import type { BuildupStatus, DayFile, DaySummary } from './types';

const TIMEFRAMES = [1, 5, 10, 15, 20, 30];
const MIN_STEP = 6; // px per bucket for the densest view (1m scrolls horizontally)
const MAX_STEP = 40; // px per bucket cap so short timeframes don't spread out too far

const fmtDay = (day: string) => {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtNum = (v: number, digits = 2) => v.toFixed(digits);
const fmtSigned = (v: number, digits = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

const BUILDUP_ROWS: BuildupStatus[] = ['Long buildup', 'Short buildup', 'Short covering', 'Long unwinding'];

interface Hover {
  idx: number;
  clientX: number;
  clientY: number;
}

export function App() {
  const [index, setIndex] = useState<DaySummary[] | null>(null);
  const [day, setDay] = useState<string>('');
  const [tf, setTf] = useState<number>(1);
  const [file, setFile] = useState<DayFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [availW, setAvailW] = useState(800);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const base = import.meta.env.BASE_URL;

  // Load the list of available days, then default to the first one.
  useEffect(() => {
    fetch(`${base}data/index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
        return r.json() as Promise<DaySummary[]>;
      })
      .then((list) => {
        setIndex(list);
        if (list.length) setDay(list[0].day);
      })
      .catch((e) => setError(String(e)));
  }, [base]);

  // Load the selected day's minute data.
  useEffect(() => {
    if (!day) return;
    setFile(null);
    setHover(null);
    fetch(`${base}data/${day}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`${day}.json: HTTP ${r.status}`);
        return r.json() as Promise<DayFile>;
      })
      .then(setFile)
      .catch((e) => setError(String(e)));
  }, [day, base]);

  // Track the visible width so buckets can fill the screen when there are few of them.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvailW(el.clientWidth));
    ro.observe(el);
    setAvailW(el.clientWidth);
    return () => ro.disconnect();
  }, [file]);

  const buckets = useMemo(() => (file ? aggregate(file.rows, tf) : []), [file, tf]);
  const n = buckets.length;
  const step = n > 0
    ? Math.min(MAX_STEP, Math.max(MIN_STEP, Math.floor((availW - AXIS_W - PAD * 2) / Math.max(n - 1, 1))))
    : MIN_STEP;

  const pcrValues = useMemo(() => buckets.map((b) => b.pcr), [buckets]);
  const biasValues = useMemo(() => buckets.map((b) => b.bias), [buckets]);
  const changeValues = useMemo(() => buckets.map((b) => b.change), [buckets]);

  const onPlotMove = (e: MouseEvent) => {
    const el = plotRef.current;
    if (!el || n === 0) return;
    const left = el.getBoundingClientRect().left;
    const raw = Math.round((e.clientX - left - PAD) / step);
    const idx = Math.min(n - 1, Math.max(0, raw));
    setHover({ idx, clientX: e.clientX, clientY: e.clientY });
  };

  const hb = hover ? buckets[hover.idx] : null;
  const summary = index?.find((d) => d.day === day);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!index) return <div className="page"><p>Loading…</p></div>;

  return (
    <div className="page">
      <header className="controls">
        <h1>PCR vs Nifty change</h1>
        <label>
          Date
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            {index.map((d) => (
              <option key={d.day} value={d.day}>{fmtDay(d.day)}</option>
            ))}
          </select>
        </label>
        <label>
          Timeframe
          <select value={tf} onChange={(e) => setTf(Number(e.target.value))}>
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>{t === 1 ? '1 min' : `${t} min`}</option>
            ))}
          </select>
        </label>
        {summary && (
          <span className="meta">
            {n} bars · PCR on {summary.pcrMinutes}/{summary.minutes} min · avg {summary.avgContracts} contracts
          </span>
        )}
      </header>

      {!file ? (
        <p>Loading {day}…</p>
      ) : (
        <div className="scroller" ref={scrollerRef}>
          <div
            className="plots"
            ref={plotRef}
            onMouseMove={onPlotMove}
            onMouseLeave={() => setHover(null)}
          >
            <Chart
              title="PCR (OI)"
              values={pcrValues}
              step={step}
              color="#0969da"
              format={(v) => fmtNum(v)}
              hoverIdx={hover?.idx ?? null}
            />
            <Chart
              title="Buildup bias"
              values={biasValues}
              step={step}
              color="#8250df"
              zeroLine
              signDots
              format={(v) => fmtSigned(v, 0)}
              hoverIdx={hover?.idx ?? null}
            />
            <Chart
              title="Nifty Δ pts"
              values={changeValues}
              step={step}
              color="#6e7781"
              zeroLine
              signDots
              format={(v) => fmtSigned(v, 0)}
              hoverIdx={hover?.idx ?? null}
            />
          </div>
          <div className="xAxis" style={{ width: AXIS_W + n * step + PAD }}>
            {buckets.map((b, i) =>
              i % Math.max(1, Math.round(60 / step)) === 0 ? (
                <span key={i} style={{ left: AXIS_W + PAD + i * step }}>{b.label}</span>
              ) : null
            )}
          </div>
        </div>
      )}

      {hb && hover && (
        <div className="tooltip" style={{ left: hover.clientX + 14, top: hover.clientY + 14 }}>
          <div><strong>{hb.label}–{hb.endLabel}</strong></div>
          <div>PCR: {hb.pcr === null ? '—' : fmtNum(hb.pcr, 4)}{hb.contracts !== null && <span className="muted"> ({hb.contracts} contracts)</span>}</div>
          <div>Nifty: {hb.close === null ? '—' : fmtNum(hb.close)}</div>
          <div>
            Δ: {hb.change === null ? '—' : `${fmtSigned(hb.change)} pts`}
            {hb.changePct !== null && <span className="muted"> ({fmtSigned(hb.changePct, 2)}%)</span>}
          </div>
          {hb.buildup && (
            <table className="bu">
              <thead><tr><th></th><th>CE</th><th>PE</th></tr></thead>
              <tbody>
                {BUILDUP_ROWS.map((s) => (
                  <tr key={s}><td>{s}</td><td>{hb.buildup!.CE[s]}</td><td>{hb.buildup!.PE[s]}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div>Bias: {hb.bias === null ? '—' : fmtSigned(hb.bias, 0)}</div>
        </div>
      )}

      <footer className="caveat">
        PCR is the stored Pcr document: total put OI ÷ total call OI over the NIFTY contracts the data process
        subscribes to (about 12, near the money), so it is not the full-chain PCR. One document per minute.
        Buildup bias = contracts reading bullish for NIFTY minus bearish, from each contract's price and OI change
        over the last 5 minutes (call long buildup / short covering and put short buildup / long unwinding are
        bullish; the reverse is bearish).
      </footer>
    </div>
  );
}
