import { useState } from 'react';
import { Table } from 'react-bootstrap';

const TIMES_KEY = 'tradeTables.showTimes';
const readShowTimes = () => { try { return localStorage.getItem(TIMES_KEY) === '1'; } catch { return false; } };

const money = (v: number | undefined | null) => (v == null || !Number.isFinite(v) ? '—' : `₹${v.toFixed(2)}`);
const pnlClass = (v: number) => (v >= 0 ? 'text-success' : 'text-danger');
const when = (v: any) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// Open and closed trades as tables - shared by the trader's Profile > Trades tab and Admin > Trades.
export default function TradeTables({ open, closed, showUser }: { open: any[]; closed: any[]; showUser?: boolean }) {
  const [showTimes, setShowTimes] = useState(readShowTimes);
  const toggleTimes = (v: boolean) => { setShowTimes(v); try { localStorage.setItem(TIMES_KEY, v ? '1' : '0'); } catch { /* storage blocked */ } };
  return (
    <>
      <h6 className="mt-3">Open positions</h6>
      {open.length === 0 ? (
        <p className="text-muted small">No open positions.</p>
      ) : (
        <Table striped hover responsive size="sm">
          <thead>
            <tr>{showUser && <th>User</th>}<th>Contract</th><th>Qty</th><th>Entry</th><th>Now</th><th>P&amp;L</th></tr>
          </thead>
          <tbody>
            {open.map((t, i) => {
              const pnl = (t.lastTradePrice - t.price) * t.quantity || 0;
              return (
                <tr key={t._id || `${t.token}-${i}`}>
                  {showUser && <td>{t.user}</td>}
                  <td>{t.tsym}</td><td>{t.quantity}</td>
                  <td>{money(t.price)}</td><td>{money(t.lastTradePrice)}</td>
                  <td className={`fw-bold ${pnlClass(pnl)}`}>{pnl >= 0 ? '+' : ''}{money(pnl)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <div className="d-flex justify-content-between align-items-center mt-3">
        <h6 className="mb-0">Closed trades</h6>
        <label className="form-check form-check-inline small text-body-secondary mb-0 me-0">
          <input type="checkbox" className="form-check-input" checked={showTimes} onChange={(e) => toggleTimes(e.target.checked)} />
          <span className="form-check-label">Show bought / sold times</span>
        </label>
      </div>
      {closed.length === 0 ? (
        <p className="text-muted small">No closed trades in this period.</p>
      ) : (
        <Table striped hover responsive size="sm">
          <thead>
            <tr>{showUser && <th>User</th>}<th>Contract</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&amp;L</th>{showTimes && <><th>Bought</th><th>Sold</th></>}</tr>
          </thead>
          <tbody>
            {closed.map((t, i) => {
              const pnl = t.realizedPnL || 0;
              return (
                <tr key={t._id || i}>
                  {showUser && <td>{t.user}</td>}
                  <td>{t.tsym}</td><td>{t.quantity}</td>
                  <td>{money(t.entryPrice)}</td><td>{money(t.exitPrice)}</td>
                  <td className={`fw-bold ${pnlClass(pnl)}`}>{pnl >= 0 ? '+' : ''}{money(pnl)}</td>
                  {showTimes && <><td className="small">{when(t.entryTime)}</td><td className="small">{when(t.exitTime)}</td></>}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}
