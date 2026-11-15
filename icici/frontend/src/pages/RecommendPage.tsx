import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, ListGroup, Row, Table } from 'react-bootstrap';
import { matchSymbols, SYMBOL_SEARCH_MIN_CHARS } from '../components/orderEntryShared';
import ContractorLayout from '../components/ContractorLayout';
import ContractorTrades from '../components/ContractorTrades';
import { useAuth } from '../context/AuthContext';
import { apiFetch, apiPost, readError } from '../utils/api';

interface Rec { id: string; contract: string; index: string; entry: number; target: number; stop: number; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'; note: string | null; createdAt: string }
const VARIANT: Record<Rec['status'], string> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', EXPIRED: 'secondary' };

// Advanced (Business) contractors: submit a recommendation; the owner approves or rejects each one.
export default function RecommendPage() {
  const { user } = useAuth();
  const [recs, setRecs] = useState<Rec[]>([]);
  const [form, setForm] = useState({ entry: '', target: '', stop: '' });
  // Contract search, exactly like Search & Buy: type 3 letters (TCS, NIFTY, ...), pick from the suggestions (index and stock options; the nearest expiry).
  const [symbols, setSymbols] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ index: string; strike: number; right: 'CE' | 'PE'; label: string } | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    apiFetch(import.meta.env.BASE_URL + 'symbols.txt').then((r) => r.text()).then((t) => setSymbols(t.split('\n').map((l) => l.trim()).filter((l) => /^[A-Z0-9&-]+_\d+(\.\d+)?_(CE|PE)$/.test(l)).sort())).catch(() => undefined);
    const away = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  const suggestions = open ? matchSymbols(query.toUpperCase().replace(/[ ]+/g, '_'), symbols, (x) => x) : [];
  const pick = (label: string) => { const parts = label.split('_'); const right = parts[parts.length - 1]; const strike = parts[parts.length - 2]; const index = parts.slice(0, -2).join('_'); setPicked({ index: index as string, strike: Number(strike), right: right as 'CE' | 'PE', label }); setQuery(label); setOpen(false); };
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => apiFetch('/recommendations').then((r) => (r.ok ? r.json() : [])).then(setRecs).catch(() => undefined), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<any>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked) { setMsg({ ok: false, text: `Search for the contract (type at least ${SYMBOL_SEARCH_MIN_CHARS} letters) and pick one from the list.` }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await apiPost('/recommendations', { symbol: picked.label, entry: Number(form.entry), target: Number(form.target), stop: Number(form.stop) });
      if (!res.ok) { setMsg({ ok: false, text: await readError(res) }); return; }
      setMsg({ ok: true, text: 'Recorded. It is waiting for approval.' });
      setForm({ entry: '', target: '', stop: '' }); setPicked(null); setQuery('');
      load();
    } finally { setBusy(false); }
  };

  const sebiOk = !!user?.sebi?.verified;
  return (
    <ContractorLayout>
      {!sebiOk && <Alert variant="warning">Your SEBI Registration No. {user?.sebi ? 'is waiting for the owner to verify it' : 'is not recorded'}. Add it on your profile; you can submit once it is verified and valid.</Alert>}
      {user?.blockedReason && user.status === 'ACTIVE' && <Alert variant="warning">{user.blockedReason}</Alert>}
      <Row className="g-3">
        <Col lg={5}>
          <Card>
            <Card.Header>New recommendation</Card.Header>
            <Card.Body>
              <Form onSubmit={submit}>
                <Row className="g-2">
                  <Col xs={12}>
                    <Form.Label className="small mb-0">Contract</Form.Label>
                    <div ref={boxRef} style={{ position: 'relative' }}>
                      <Form.Control value={query} placeholder="Type 3 letters, e.g. TCS or NIFTY_24150_CE" autoComplete="off"
                        onChange={(e) => { setQuery(e.target.value); setPicked(null); setOpen(true); }} onFocus={() => setOpen(true)} />
                      {suggestions.length > 0 && (
                        <ListGroup style={{ position: 'absolute', zIndex: 1000, width: '100%', maxHeight: 300, overflowY: 'auto' }}>
                          {suggestions.map((x) => <ListGroup.Item key={x} action onClick={() => pick(x)} style={{ cursor: 'pointer' }}>{x}</ListGroup.Item>)}
                        </ListGroup>
                      )}
                    </div>
                    {picked && <div className="small text-success mt-1">{picked.index} {picked.strike} {picked.right} (nearest expiry)</div>}
                  </Col>
                  <Col xs={4}><Form.Label className="small mb-0">Entry</Form.Label><Form.Control inputMode="decimal" value={form.entry} onChange={set('entry')} required /></Col>
                  <Col xs={4}><Form.Label className="small mb-0">Target</Form.Label><Form.Control inputMode="decimal" value={form.target} onChange={set('target')} required /></Col>
                  <Col xs={4}><Form.Label className="small mb-0">Stop loss</Form.Label><Form.Control inputMode="decimal" value={form.stop} onChange={set('stop')} required /></Col>
                </Row>
                <div className="small text-muted mt-2">Prices are option prices. A recommendation cannot be edited or withdrawn once recorded, and lapses at the end of the day if it is not approved.</div>
                <Button type="submit" className="mt-3" disabled={busy || user?.status !== 'ACTIVE'}>{busy ? 'Sending…' : 'Submit recommendation'}</Button>
                {msg && <div className={`mt-2 small ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</div>}
              </Form>
            </Card.Body>
          </Card>
        </Col>
        <Col lg={7}>
          <Card className="mb-3">
            <Card.Header>My recommendations</Card.Header>
            <Card.Body className="p-0">
              <Table size="sm" responsive className="mb-0">
                <thead><tr><th>When</th><th>Contract</th><th className="text-end">Entry</th><th className="text-end">Target</th><th className="text-end">Stop</th><th>Status</th></tr></thead>
                <tbody>
                  {recs.length === 0 && <tr><td colSpan={6} className="text-muted p-3">Nothing yet.</td></tr>}
                  {recs.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}</td>
                      <td>{r.index} {r.contract}</td><td className="text-end">{r.entry}</td><td className="text-end">{r.target}</td><td className="text-end">{r.stop}</td>
                      <td><Badge bg={VARIANT[r.status]}>{r.status.toLowerCase()}</Badge>{r.note ? <span className="small text-muted ms-1">{r.note}</span> : null}</td>
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
