import { useEffect, useState } from 'react';
import { Card, Button, Modal, Form, Alert, Spinner, Badge } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';
import { apiFetch, apiPost, readError } from '../utils/api';
import LevelTable from './LevelTable';

interface LevelStatus {
  level: 'beginner' | 'advanced';
  advancedSince: string | null;
  successfulWeeks: number;
  requiredWeeks: number;
  pendingUpgradeRequest: boolean;
  pendingCapitalRequest: boolean;
  accountClosed: boolean;
}

// Profile card: the user's level, how to become Advanced (request + admin approval; giving a GSTIN is on the company profile below) and,
// for Advanced users, the capital-increase request with the successful-weeks progress shown openly.
export default function AccountLevelCard() {
  const { user } = useAuth();
  const [status, setStatus] = useState<LevelStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [showCapital, setShowCapital] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    apiFetch('/user/level-status')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((s: LevelStatus) => { setStatus(s); setLoadFailed(false); })
      .catch(() => setLoadFailed(true));
  };
  useEffect(load, [user?.proficiencyLevel]);

  const submit = async (url: string, body: unknown, done: string, close: () => void) => {
    setBusy(true); setError(null);
    try {
      const res = await apiPost(url, body);
      if (!res.ok) throw new Error(await readError(res));
      close(); setNotice(done); load();
    } catch (e: any) { setError(e?.message ?? 'Something went wrong'); } finally { setBusy(false); }
  };

  const advanced = status?.level === 'advanced';
  const weeksText = status ? `Successful weeks: ${status.successfulWeeks} of ${status.requiredWeeks}` : '';
  const capitalReason = !status ? '' : status.accountClosed ? 'Your account is closed' : status.successfulWeeks < status.requiredWeeks ? `You need ${status.requiredWeeks} successful weeks (you have ${status.successfulWeeks})` : status.pendingCapitalRequest ? 'Your request is waiting for an admin' : '';

  return (
    <Card className="mb-3" id="upgrade">
      <Card.Header className="fw-bold d-flex justify-content-between align-items-center">
        <span>Account level</span>
        {status && <Badge bg={advanced ? 'success' : 'secondary'}>{advanced ? 'Advanced' : 'Beginner'}</Badge>}
      </Card.Header>
      <Card.Body>
        {loadFailed && <p className="text-muted small mb-0">Your level could not be loaded right now.</p>}
        {!status && !loadFailed && <Spinner animation="border" size="sm" />}
        {notice && <Alert variant="success" className="py-2" dismissible onClose={() => setNotice(null)}>{notice}</Alert>}
        {status && !advanced && (
          <>
            <p className="small">You are a <strong>Beginner</strong>: Flash Trade only, with fixed target and stop-loss. Advanced adds Search &amp; Buy, your own target and stop-loss, and a larger capital, with a lower profit share. <strong>Advanced is permanent</strong>; you cannot go back.</p>
            <LevelTable highlight="beginner" />
            {status.pendingUpgradeRequest
              ? <Alert variant="info" className="py-2 mb-0">Your request is waiting for an admin.</Alert>
              : <Button onClick={() => { setAccepted(false); setError(null); setShowUpgrade(true); }} disabled={status.accountClosed}>Request Advanced</Button>}
            {status.accountClosed && <div className="small text-muted mt-2">Your account is closed, so you cannot request Advanced.</div>}
            <div className="small text-muted mt-2">Have a GSTIN? Add it under Account Type below and your account becomes Advanced immediately (an invoice is then due for every payment).</div>
          </>
        )}
        {status && advanced && (
          <>
            <p className="small mb-2">You are <strong>Advanced</strong>{status.advancedSince ? ` since ${new Date(status.advancedSince).toLocaleDateString('en-IN')}` : ''}.</p>
            <p className="small mb-2">Need more capital? An admin decides, and you need at least {status.requiredWeeks} successful weeks first. A successful week is a completed Wednesday-to-Tuesday week with a net profit and no daily or weekly loss limit breach. <strong>{weeksText}</strong></p>
            <Button variant="outline-primary" disabled={!!capitalReason} onClick={() => { setAmount(''); setError(null); setShowCapital(true); }}>Request more capital</Button>
            {capitalReason && <div className="small text-muted mt-2">{capitalReason}</div>}
          </>
        )}
      </Card.Body>

      <Modal show={showUpgrade} onHide={() => setShowUpgrade(false)} centered size="lg">
        <Modal.Header closeButton><Modal.Title>Request Advanced</Modal.Title></Modal.Header>
        <Modal.Body>
          <LevelTable />
          <Form.Check id="accept-advanced" type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)}
            label="I have read and accept the Advanced terms. I understand Advanced is permanent, that it takes effect when an admin approves, and that my profit share changes as shown above." />
          {error && <Alert variant="danger" className="mt-3 mb-0 py-2">{error}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowUpgrade(false)} disabled={busy}>Cancel</Button>
          <Button disabled={!accepted || busy} onClick={() => submit('/user/upgrade-request', { acceptTerms: true }, 'Your request was sent. An admin will review it.', () => setShowUpgrade(false))}>{busy ? <Spinner animation="border" size="sm" /> : 'Send request'}</Button>
        </Modal.Footer>
      </Modal>

      <Modal show={showCapital} onHide={() => setShowCapital(false)} centered>
        <Modal.Header closeButton><Modal.Title>Request more capital</Modal.Title></Modal.Header>
        <Modal.Body>
          <Form.Label className="fw-semibold">Capital you are asking for (₹)</Form.Label>
          <Form.Control type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`More than ₹${(user?.accountCapital ?? 0).toLocaleString('en-IN')}`} />
          <Form.Text className="text-muted">At most 10 times your current capital. An admin decides.</Form.Text>
          {error && <Alert variant="danger" className="mt-3 mb-0 py-2">{error}</Alert>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowCapital(false)} disabled={busy}>Cancel</Button>
          <Button disabled={busy || !(Number(amount) > 0)} onClick={() => submit('/user/capital-request', { amount: Number(amount) }, 'Your request was sent. An admin will review it.', () => setShowCapital(false))}>{busy ? <Spinner animation="border" size="sm" /> : 'Send request'}</Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}
