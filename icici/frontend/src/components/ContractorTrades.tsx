import { useCallback, useEffect, useState } from 'react';
import { Button, Table } from 'react-bootstrap';
import { apiFetch, apiPost, readError } from '../utils/api';

interface SafeTrade { contract: string | null; entryPrice: number | null; ltp: number | null; pnl: number | null; open: boolean; entryTime: string | null; exitTime: string | null; recommendationId?: string | null; addMore?: boolean; addedMore?: boolean }
const money = (n: number | null) => (n == null ? '–' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const fmtTime = (t: string | null) => (t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '–');

// Read-only, except Add More: entry price and live P&L of the trades produced by THIS contractor's own forecasts / recommendations (agreement clause 5A).
// Add More (a recommendation's open trade, once) buys the rest of the investment limit in that option.
export default function ContractorTrades() {
  const [trades, setTrades] = useState<SafeTrade[] | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const load = useCallback(() => apiFetch('/contractor/trades').then((r) => (r.ok ? r.json() : null)).then((d) => { if (Array.isArray(d)) setTrades(d); }).catch(() => undefined), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  const addMore = async (id: string) => {
    setAdding(id); setNote(null);
    try {
      const res = await apiPost(`/recommendations/${id}/add-more`);
      if (!res.ok) { setNote({ ok: false, text: await readError(res) }); return; }
      const d = await res.json();
      setNote({ ok: true, text: `Added: ${money(d.budget)} more in the same option.` });
      load();
    } catch { setNote({ ok: false, text: 'Could not reach the server. Nothing was added; check your trades before trying again.' }); }
    finally { setAdding(null); }
  };
  if (trades === null) return <div className="text-muted">Loading…</div>;
  if (trades.length === 0) return <div className="text-muted">No trades resulted from your submissions yet.</div>;
  return (
    <>
      <Table size="sm" responsive>
        <thead><tr><th>Contract</th><th className="text-end">Entry price</th><th className="text-end">Now</th><th className="text-end">P&amp;L</th><th>Status</th><th>Entered</th><th></th></tr></thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={i}>
              <td>{t.contract}</td>
              <td className="text-end">{money(t.entryPrice)}</td>
              <td className="text-end">{t.open ? money(t.ltp) : '–'}</td>
              <td className={`text-end ${t.pnl != null && t.pnl < 0 ? 'text-danger' : 'text-success'}`}>{money(t.pnl)}</td>
              <td>{t.open ? 'Open' : `Closed ${fmtTime(t.exitTime)}`}</td>
              <td>{fmtTime(t.entryTime)}</td>
              <td>
                {t.addMore && t.recommendationId && (
                  <Button size="sm" variant="outline-primary" disabled={adding !== null} onClick={() => addMore(t.recommendationId as string)}>
                    {adding === t.recommendationId ? 'Adding…' : 'Add More'}
                  </Button>
                )}
                {t.addedMore && <span className="small text-muted">Added more (used)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {note && <div className={`small ${note.ok ? 'text-success' : 'text-danger'}`}>{note.text}</div>}
    </>
  );
}
