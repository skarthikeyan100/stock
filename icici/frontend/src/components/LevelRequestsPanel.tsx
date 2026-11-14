import { useEffect, useState } from 'react';
import { Table, Button, Form, Modal, Alert, Spinner, Card } from 'react-bootstrap';
import { apiFetch, apiPost, readError } from '../utils/api';

interface RequestRow {
  id: string;
  user: string;
  userName?: string;
  amount?: number;
  successfulWeeks: number;
  currentCapital?: number;
  createdAt: string;
}

type Kind = 'upgrade' | 'capital';
const DEFAULT_UPGRADE_CAPITAL = 200000;
const inr = (n?: number) => (n === undefined || n === null ? '—' : `₹${n.toLocaleString('en-IN')}`);

function RequestTable({ kind, rows, onChanged, setError }: { kind: Kind; rows: RequestRow[]; onChanged: () => void; setError: (m: string | null) => void }) {
  const [capital, setCapital] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<RequestRow | null>(null);
  const [note, setNote] = useState('');
  const base = kind === 'upgrade' ? '/admin/upgrade-requests' : '/admin/capital-requests';
  const field = kind === 'upgrade' ? 'capital' : 'amount';
  const valueFor = (r: RequestRow) => capital[r.id] ?? String(kind === 'upgrade' ? DEFAULT_UPGRADE_CAPITAL : r.amount ?? '');

  const decide = async (r: RequestRow, decision: 'approve' | 'reject') => {
    setBusyId(r.id); setError(null);
    try {
      const body: Record<string, unknown> = { decision };
      if (decision === 'approve') {
        const v = Number(valueFor(r));
        if (!(v > 0)) throw new Error('Enter a capital greater than 0');
        body[field] = v;
      } else if (note.trim()) body.note = note.trim();
      const res = await apiPost(`${base}/${encodeURIComponent(r.id)}/decision`, body);
      if (!res.ok) throw new Error(await readError(res));
      setRejecting(null); setNote('');
      onChanged();
    } catch (e: any) { setError(e?.message ?? 'Failed'); } finally { setBusyId(null); }
  };

  return (
    <>
      {rows.length === 0 ? <p className="text-center text-muted py-3 mb-0">No pending requests.</p> : (
        <Table striped hover responsive className="mb-0">
          <thead>
            <tr><th>User</th>{kind === 'capital' && <th>Requested</th>}<th>Successful weeks</th><th>Current capital</th><th>Created</th><th>{kind === 'upgrade' ? 'Capital to give (₹)' : 'Capital to approve (₹)'}</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.userName ? `${r.userName} ` : ''}<span className="text-muted small">{r.user}</span></td>
                {kind === 'capital' && <td>{inr(r.amount)}</td>}
                <td>{r.successfulWeeks}</td>
                <td>{inr(r.currentCapital)}</td>
                <td className="small">{new Date(r.createdAt).toLocaleString('en-IN')}</td>
                <td><Form.Control size="sm" type="number" min="0" style={{ maxWidth: 130 }} value={valueFor(r)} onChange={(e) => setCapital((c) => ({ ...c, [r.id]: e.target.value }))} /></td>
                <td>
                  <div className="d-flex gap-1">
                    <Button size="sm" variant="success" disabled={busyId === r.id} onClick={() => decide(r, 'approve')}>Approve</Button>
                    <Button size="sm" variant="outline-danger" disabled={busyId === r.id} onClick={() => { setNote(''); setRejecting(r); }}>Reject</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal show={!!rejecting} onHide={() => setRejecting(null)} centered size="sm">
        <Modal.Header closeButton><Modal.Title>Reject request</Modal.Title></Modal.Header>
        <Modal.Body>
          <Form.Label className="small">Note for {rejecting?.user} (optional)</Form.Label>
          <Form.Control as="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
          <Button variant="danger" disabled={!!rejecting && busyId === rejecting.id} onClick={() => rejecting && decide(rejecting, 'reject')}>Reject</Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

// Admin > Level Requests: pending Beginner->Advanced upgrade requests and Advanced capital-increase requests.
export default function LevelRequestsPanel() {
  const [upgrades, setUpgrades] = useState<RequestRow[] | null>(null);
  const [capitals, setCapitals] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    const get = (url: string, set: (r: RequestRow[]) => void) =>
      apiFetch(url).then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
        .then((d) => set(Array.isArray(d) ? d : []))
        .catch(() => setError('Could not load the requests'));
    void get('/admin/upgrade-requests?status=pending', setUpgrades);
    void get('/admin/capital-requests?status=pending', setCapitals);
  };
  useEffect(load, []);

  return (
    <>
      {error && <Alert variant="danger" dismissible onClose={() => setError(null)}>{error}</Alert>}
      <Card className="mb-3">
        <Card.Header className="fw-bold">Advanced upgrade requests</Card.Header>
        <Card.Body className="p-0">{upgrades ? <RequestTable kind="upgrade" rows={upgrades} onChanged={load} setError={setError} /> : <div className="text-center py-3"><Spinner animation="border" size="sm" /></div>}</Card.Body>
      </Card>
      <Card className="mb-3">
        <Card.Header className="fw-bold">Capital increase requests</Card.Header>
        <Card.Body className="p-0">{capitals ? <RequestTable kind="capital" rows={capitals} onChanged={load} setError={setError} /> : <div className="text-center py-3"><Spinner animation="border" size="sm" /></div>}</Card.Body>
      </Card>
    </>
  );
}
