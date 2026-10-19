import { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';

export const AXIS_W = 64;
export const PAD = 12;
export const CHART_H = 260;

export interface ChartProps {
  title: string;
  values: (number | null)[];
  step: number; // px per bucket
  color: string;
  zeroLine?: boolean;
  signDots?: boolean; // colour each dot green/red by sign (used for the change chart)
  format: (v: number) => string;
  hoverIdx: number | null;
}

// One line chart: a sticky y-axis column on the left and a plot SVG of width
// PAD*2 + (n-1)*step. Both charts are rendered inside the same horizontal scroller
// so they scroll together, and the sticky axis keeps the scale visible.
export function Chart({ title, values, step, color, zeroLine, signDots, format, hoverIdx }: ChartProps) {
  const axisRef = useRef<SVGGElement>(null);
  const n = values.length;
  const plotW = PAD * 2 + Math.max(0, n - 1) * step;

  const { x, y } = useMemo(() => {
    const present = values.filter((v): v is number => v !== null);
    let lo = present.length ? Math.min(...present) : 0;
    let hi = present.length ? Math.max(...present) : 1;
    if (zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08;
    const x = (i: number) => PAD + i * step;
    const y = d3.scaleLinear().domain([lo - pad, hi + pad]).range([CHART_H - 22, 14]);
    return { x, y };
  }, [values, step, zeroLine]);

  useEffect(() => {
    if (!axisRef.current) return;
    const g = d3.select(axisRef.current);
    g.selectAll('*').remove();
    g.append('g')
      .attr('transform', `translate(${AXIS_W - 1},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat((v) => format(v as number)).tickSizeOuter(0))
      .call((ax) => ax.select('.domain').remove());
  }, [y, format]);

  const line = d3
    .line<number | null>()
    .defined((v) => v !== null)
    .x((_, i) => x(i))
    .y((v) => y(v as number));
  const path = line(values) ?? '';

  const ticks = y.ticks(5);
  const hoverVal = hoverIdx !== null ? values[hoverIdx] : null;

  return (
    <div className="chartRow" style={{ height: CHART_H }}>
      <svg className="yAxis" width={AXIS_W} height={CHART_H}>
        <text x={6} y={14} className="chartTitle">{title}</text>
        <g ref={axisRef} />
      </svg>
      <svg className="plot" width={plotW} height={CHART_H}>
        {ticks.map((t) => (
          <line key={t} x1={0} x2={plotW} y1={y(t)} y2={y(t)} className="grid" />
        ))}
        {zeroLine && <line x1={0} x2={plotW} y1={y(0)} y2={y(0)} className="zero" />}
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
        {step >= 8 &&
          values.map((v, i) =>
            v === null ? null : (
              <circle
                key={i}
                cx={x(i)}
                cy={y(v)}
                r={2.2}
                fill={signDots ? (v >= 0 ? '#1a7f37' : '#cf222e') : color}
              />
            )
          )}
        {hoverIdx !== null && (
          <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={0} y2={CHART_H} className="cross" />
        )}
        {hoverIdx !== null && hoverVal !== null && (
          <circle cx={x(hoverIdx)} cy={y(hoverVal)} r={4} fill={color} stroke="#fff" strokeWidth={1.5} />
        )}
      </svg>
    </div>
  );
}
