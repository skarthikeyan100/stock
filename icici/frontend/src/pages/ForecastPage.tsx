import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, ProgressBar, Row, Table } from 'react-bootstrap';
import ContractorLayout from '../components/ContractorLayout';
import ContractorTrades from '../components/ContractorTrades';
import { useAuth } from '../context/AuthContext';
import { useEventSource } from '../hooks/useEventSource';
import { apiFetch, apiPost, readError } from '../utils/api';

interface Fc { id: string; direction: 'UP' | 'DOWN'; confidence: string | null; submittedAt: string; windowEndsAt: string; outcome: 'OPEN' | 'CORRECT' | 'INCORRECT' | 'NEUTRAL' | 'VOID'; indexAtSubmit: number; indexAtEnd: number | null }
interface State { nifty: number | null; dailyLimit: number; usedToday: number; windowMinutes: number; hours: { start: string; end: string }; openWindow: Fc | null; available: boolean }
interface Acc { correct: number; incorrect: number; neutral: number; void: number; scored: number; accuracyPct: number | null }
const OUT_BG: Record<Fc['outcome'], string> = { OPEN: 'info', CORRECT: 'success', INCORRECT: 'danger', NEUTRAL: 'secondary', VOID: 'dark' };
const hms = (t: string) => new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

// Beginner (Individual) home: Flash Forecast. Two big buttons, an optional confidence, the live NIFTY 50 value. A forecast cannot be edited or withdrawn.
export default function ForecastPage() {
  const { user } = useAuth();
  const [state, setState] = useState<State | null>(null);
  const [history, setHistory] = useState<Fc[]>([]);
  const [acc, setAcc] = useState<{ d7: Acc; d30: Acc; all: Acc } | null>(null);
  const [conf, setConf] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [nifty, setNifty] = useState<{ ltp: number; change?: number } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const [s, h, a] = await Promise.all([apiFetch('/forecast/state'), apiFetch('/forecast/history'), apiFetch('/forecast/accuracy')]);
    if (s.ok) setState(await s.json());
    if (h.ok) setHistory(await h.json());
    if (a.ok) setAcc(await a.json());
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEventSource('/niftystream', { onMessage: (e) => { try { const d = JSON.parse(e.data); const q = d?.nifty ?? d; if (Number.isFinite(Number(q?.ltp))) setNifty({ ltp: Number(q.ltp) }); } catch { /* ignore */ } } });

  const send = async (direction: 'UP' | 'DOWN') => {
    setBusy(true); setMsg(null);
    try {
      const res = await apiPost('/forecast', { direction, confidence: conf || undefined });
      if (!res.ok) { setMsg({ ok: false, text: await readError(res) }); return; }
      const d = await res.json();
      setMsg({ ok: true, text: d.message });
      load();
    } finally { setBusy(false); }
  };

  const open = state?.openWindow;
  const left = open ? Math.max(0, new Date(open.windowEndsAt).getTime() - now) : 0;
  const total = (state?.windowMinutes ?? 15) * 60_000;
  const canSend = !!state && state.available && user?.status === 'ACTIVE' && !user?.blockedReason && !open && state.usedToday < state.dailyLimit;
  const ltp = nifty?.ltp ?? state?.nifty ?? null;

  return (
    <ContractorLayout>
      {user?.blockedReason && user.status === 'ACTIVE' && <Alert variant="warning">{user.blockedReason}</Alert>}
      <Row className="g-3">
        <Col lg={5}>
          <Card>
            <Card.Header className="d-flex justify-content-between align-items-center">
              <span>Flash Forecast</span>
              <span className="fw-bold">NIFTY 50 {ltp != null ? ltp.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '–'}</span>
            </Card.Header>
            <Card.Body>
              <p className="text-muted small mb-3">Will NIFTY 50 move up or down over the next {state?.windowMinutes ?? 15} minutes? Accepted {state?.hours.start}–{state?.hours.end} IST. You have used {state?.usedToday ?? 0} of {state?.dailyLimit ?? 3} today. A forecast cannot be edited or withdrawn once recorded.</p>
              <Form.Select size="sm" className="mb-3" value={conf} onChange={(e) => setConf(e.target.value)} aria-label="Confidence" style={{ maxWidth: 220 }}>
                <option value="">Confidence (optional)</option><option>Low</option><option>Medium</option><option>High</option>
              </Form.Select>
              <div className="d-flex gap-3">
                <Button variant="success" size="lg" className="flex-fill py-4 fs-4" disabled={!canSend || busy} onClick={() => send('UP')}>▲ Up</Button>
                <Button variant="danger" size="lg" className="flex-fill py-4 fs-4" disabled={!canSend || busy} onClick={() => send('DOWN')}>▼ Down</Button>
              </div>
              {open && (
                <div className="mt-3">
                  <div className="small mb-1">Forecast recorded at {hms(open.submittedAt)}. Window closes at {hms(open.windowEndsAt)}.</div>
                  <ProgressBar now={100 - (left / total) * 100} label={`${Math.ceil(left / 1000)}s`} />
                </div>
              )}
              {state && !state.available && <div className="text-muted small mt-2">Forecasting is starting up…</div>}
              {msg && <div className={`mt-3 small ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</div>}
            </Card.Body>
          </Card>
          {acc && (
            <Card className="mt-3">
              <Card.Header>My accuracy</Card.Header>
              <Card.Body className="p-0">
                <Table size="sm" className="mb-0">
                  <thead><tr><th /><th className="text-end">Correct</th><th className="text-end">Scored</th><th className="text-end">Accuracy</th></tr></thead>
                  <tbody>
                    {([['7 days', acc.d7], ['30 days', acc.d30], ['All time', acc.all]] as const).map(([l, a]) => <tr key={l}><td>{l}</td><td className="text-end">{a.correct}</td><td className="text-end">{a.scored}</td><td className="text-end">{a.accuracyPct == null ? '–' : `${a.accuracyPct}%`}</td></tr>)}
                  </tbody>
                </Table>
              </Card.Body>
            </Card>
          )}
        </Col>
        <Col lg={7}>
          <Card className="mb-3">
            <Card.Header>My forecasts</Card.Header>
            <Card.Body className="p-0" style={{ maxHeight: 360, overflow: 'auto' }}>
              <Table size="sm" className="mb-0">
                <thead><tr><th>Time</th><th>Call</th><th>Confidence</th><th className="text-end">NIFTY at start</th><th className="text-end">at end</th><th>Outcome</th></tr></thead>
                <tbody>
                  {history.length === 0 && <tr><td colSpan={6} className="text-muted p-3">No forecasts yet.</td></tr>}
                  {history.map((f) => (
                    <tr key={f.id}>
                      <td>{new Date(f.submittedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })} {hms(f.submittedAt)}</td>
                      <td>{f.direction === 'UP' ? '▲ Up' : '▼ Down'}</td><td>{f.confidence ?? '–'}</td>
                      <td className="text-end">{f.indexAtSubmit.toLocaleString('en-IN')}</td><td className="text-end">{f.indexAtEnd == null ? '–' : f.indexAtEnd.toLocaleString('en-IN')}</td>
                      <td><Badge bg={OUT_BG[f.outcome]}>{f.outcome.toLowerCase()}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
          <Card>
            <Card.Header>Resulting trades (read-only)</Card.Header>
            <Card.Body><ContractorTrades /></Card.Body>
          </Card>
        </Col>
      </Row>
    </ContractorLayout>
  );
}
