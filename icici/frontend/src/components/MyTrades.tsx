import { useEffect, useRef, useState } from 'react';
import { Card, Alert, Spinner, Table } from 'react-bootstrap';
import DateRangeFilter, { DateRange, resolveDateRange, formatRangeLabel } from './DateRangeFilter';
import TradeTables from './TradeTables';
import { apiFetch, readError } from '../utils/api';

// The trader's own trades with the same Day / Week / Month filter and P&L summary as Admin > Trades.
export default function MyTrades({ email }: { email: string }) {
  const [range, setRange] = useState<DateRange>(() => resolveDateRange('day', '', ''));
  const [open, setOpen] = useState<any[]>([]);
  const [closed, setClosed] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const base = `/users/${encodeURIComponent(email)}/trades`;

  useEffect(() => {
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ from: range.from, to: range.to });
        const [openRes, closedRes] = await Promise.all([apiFetch(`${base}/open`), apiFetch(`${base}/closed?${qs}`)]);
        if (!openRes.ok) throw new Error(await readError(openRes));
        if (!closedRes.ok) throw new Error(await readError(closedRes));
        const [o, c] = await Promise.all([openRes.json(), closedRes.json()]);
        if (id !== requestId.current) return;
        setOpen(Array.isArray(o) ? o : []);
        setClosed(Array.isArray(c) ? c : []);
        if (range.mode === 'day') { setSummary(null); return; }
        const sq = new URLSearchParams({ from: range.from, to: range.to });
        if (range.mode === 'month') sq.set('breakdown', 'week');
        const sres = await apiFetch(`${base}/pnl-summary?${sq}`);
        if (id === requestId.current) setSummary(sres.ok ? await sres.json() : null);
      } catch (e: any) {
        if (id !== requestId.current) return;
        setOpen([]); setClosed([]); setSummary(null);
        setError(e.message || 'Failed to load trades');
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [base, range.mode, range.from, range.to]);

  const raw = closed.reduce((s, t) => s + (t.realizedPnL || 0), 0);
  const total = range.mode === 'day' || !summary ? raw : summary.eligibleTotal;

  return (
    <>
      <Card className="mb-3">
        <Card.Body>
          <DateRangeFilter value={range} onChange={setRange} size="sm" modes={['day', 'week', 'month']} />
          <div className="d-flex align-items-center gap-2 mt-2">
            <small className="text-muted">{formatRangeLabel(range)}</small>
            {loading && <Spinner animation="border" size="sm" />}
          </div>
          {error && <Alert variant="danger" dismissible onClose={() => setError(null)} className="mt-2 mb-0">{error}</Alert>}
        </Card.Body>
      </Card>

      <Card className="mb-3">
        <Card.Header className="fw-bold">P&amp;L Summary</Card.Header>
        <Card.Body>
          <div className={`fs-4 fw-bold ${total >= 0 ? 'text-success' : 'text-danger'}`}>{total >= 0 ? '+' : ''}₹{total.toFixed(2)}</div>
          {range.mode !== 'day' && summary && summary.rawTotal !== summary.eligibleTotal && (
            <small className="text-muted d-block">Raw P&amp;L: ₹{summary.rawTotal.toFixed(2)}</small>
          )}
          {summary?.forfeited && <Alert variant="warning" className="mt-2 mb-0">{summary.forfeitReason}</Alert>}
          {range.mode === 'month' && summary?.weeks?.length > 0 && (
            <Table size="sm" striped responsive className="mb-0 mt-3">
              <thead><tr><th>Week</th><th>Raw P&amp;L</th><th>Eligible P&amp;L</th><th>Status</th></tr></thead>
              <tbody>
                {summary.weeks.map((w: any, i: number) => (
                  <tr key={i}>
                    <td>{w.weekStart} – {w.weekEnd}</td>
                    <td>₹{w.rawPnL.toFixed(2)}</td>
                    <td>₹{w.eligiblePnL.toFixed(2)}</td>
                    <td>{w.forfeited ? <span className="text-danger" title={w.forfeitReason}>Forfeited</span> : <span className="text-success">OK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      <TradeTables open={open} closed={closed} />
    </>
  );
}
