import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Form, Modal } from 'react-bootstrap';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useEventSource } from '../hooks/useEventSource';
import { apiFetch, apiPost, readError } from '../utils/api';

export interface PendingApproval { id: string; kind: 'recommendation'; contractorName: string; index: string; contract: string; entry: number; target: number; stop: number; orderPrice: number; createdAt: string }

export function usePendingApprovals(enabled: boolean) {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const load = useCallback(() => {
    if (!enabled) return;
    apiFetch('/owner/approvals/pending').then((r) => (r.ok ? r.json() : null)).then((d) => { if (Array.isArray(d)) setItems(d); }).catch(() => undefined);
  }, [enabled]);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  // A new / resolved approval arrives as a notification: refetch at once instead of waiting for the poll.
  useEventSource('/notificationstream', { enabled, onOpen: load, onMessage: (e) => { try { const n = JSON.parse(e.data); if (n?.type === 'approval_required' || n?.type === 'approval_resolved') load(); } catch { /* ignore */ } } });
  return { items, reload: load };
}

// The persistent approval pop-up (spec v2.1 section 9): it cannot be dismissed and comes back after a reload; it goes away only when the owner
// approves or rejects. Mounted once in App for the admin.
export default function ApprovalPopup() {
  const { isAdmin } = useAuth();
  const { pathname } = useLocation();
  const { items, reload } = usePendingApprovals(isAdmin && pathname !== '/owner-login');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cur = items[0];
  useEffect(() => { setNote(''); setErr(''); }, [cur?.id]);
  if (!isAdmin || !cur) return null;

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true); setErr('');
    try {
      const res = await apiPost(`/owner/recommendations/${cur.id}/decision`, { decision, note: note.trim() || undefined });
      if (!res.ok) { setErr(await readError(res)); return; }
      reload();
    } finally { setBusy(false); }
  };

  return (
    <Modal show centered backdrop="static" keyboard={false} style={{ zIndex: 3000 }} backdropClassName="approval-backdrop">
      <Modal.Header>
        <Modal.Title className="h5">Approval needed {items.length > 1 && <Badge bg="danger" className="ms-2">{items.length} waiting</Badge>}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="mb-2"><strong>{cur.contractorName}</strong> recommends:</div>
        <div className="fs-5 mb-2">{cur.index} {cur.contract}</div>
        <table className="table table-sm mb-2"><tbody>
          <tr><td>Entry</td><td className="text-end">{cur.entry}</td></tr>
          <tr><td>Order price (entry − offset)</td><td className="text-end">{cur.orderPrice}</td></tr>
          <tr><td>Target</td><td className="text-end">{cur.target}</td></tr>
          <tr><td>Stop loss</td><td className="text-end">{cur.stop}</td></tr>
        </tbody></table>
        <div className="small text-muted mb-2">Received {new Date(cur.createdAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}. It lapses at the end of the day if you do nothing.</div>
        <Form.Control size="sm" placeholder="Note (optional, shown to the contractor)" value={note} onChange={(e) => setNote(e.target.value)} />
        {err && <div className="text-danger small mt-2">{err}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-danger" disabled={busy} onClick={() => decide('reject')}>Reject</Button>
        <Button variant="success" disabled={busy} onClick={() => decide('approve')}>Approve</Button>
      </Modal.Footer>
    </Modal>
  );
}

// A small link to the owner console on every admin page (the existing Admin and Trade headers are not changed).
export function OwnerConsoleLink() {
  const { isAdmin } = useAuth();
  const { pathname } = useLocation();
  const { items } = usePendingApprovals(isAdmin && pathname !== '/console' && pathname !== '/owner-login');
  if (!isAdmin || pathname === '/console' || pathname === '/owner-login') return null;
  return (
    <Link to="/console" className="btn btn-sm btn-dark" style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 1500 }}>
      Contractors {items.length > 0 && <Badge bg="danger">{items.length}</Badge>}
    </Link>
  );
}
