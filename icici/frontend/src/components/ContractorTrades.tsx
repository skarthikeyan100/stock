import { useEffect, useState } from 'react';
import { Table } from 'react-bootstrap';
import { apiFetch } from '../utils/api';

interface SafeTrade { contract: string | null; entryPrice: number | null; ltp: number | null; pnl: number | null; open: boolean; entryTime: string | null; exitTime: string | null }
const money = (n: number | null) => (n == null ? '–' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const fmtTime = (t: string | null) => (t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '–');

// Read-only: entry price and live P&L of the trades produced by THIS contractor's own forecasts / recommendations (agreement clause 5A).
export default function ContractorTrades() {
  const [trades, setTrades] = useState<SafeTrade[] | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => apiFetch('/contractor/trades').then((r) => (r.ok ? r.json() : null)).then((d) => { if (!stop && Array.isArray(d)) setTrades(d); }).catch(() => undefined);
    load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  if (trades === null) return <div className="text-muted">Loading…</div>;
  if (trades.length === 0) return <div className="text-muted">No trades resulted from your submissions yet.</div>;
  return (
    <Table size="sm" responsive>
      <thead><tr><th>Contract</th><th className="text-end">Entry price</th><th className="text-end">Now</th><th className="text-end">P&amp;L</th><th>Status</th><th>Entered</th></tr></thead>
      <tbody>
        {trades.map((t, i) => (
          <tr key={i}>
            <td>{t.contract}</td>
            <td className="text-end">{money(t.entryPrice)}</td>
            <td className="text-end">{t.open ? money(t.ltp) : '–'}</td>
            <td className={`text-end ${t.pnl != null && t.pnl < 0 ? 'text-danger' : 'text-success'}`}>{money(t.pnl)}</td>
            <td>{t.open ? 'Open' : `Closed ${fmtTime(t.exitTime)}`}</td>
            <td>{fmtTime(t.entryTime)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
