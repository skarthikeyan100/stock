import { useState, useEffect } from 'react';
import { Modal, Form, Button, Alert, Spinner } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../utils/api';
import { useLevelRules } from './LevelTable';

// Flash Trade sends no size / target / stop of its own: the server sizes it from the user's investment mode and applies the user's
// target / stop-loss points (else the global defaults). This popup edits those three user settings in one place.
export default function FlashSettingsModal({ show, onHide, defaultTarget, defaultStopLoss }: {
  show: boolean; onHide: () => void; defaultTarget: number | null; defaultStopLoss: number | null;
}) {
  const { user, refreshUser } = useAuth();
  // A Beginner's mode, target and stop-loss are fixed (the server enforces it too); Advanced users and admins edit them.
  const fixed = user?.role !== 'admin' && user?.proficiencyLevel !== 'advanced';
  const { data: levelRules } = useLevelRules();
  const [mode, setMode] = useState<'lotCount' | 'investmentAmount'>('investmentAmount');
  const [target, setTarget] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!show) return;
    setMode(user?.investmentMode ?? 'investmentAmount');
    const t = user?.targetPoints ?? user?.defaultTargetPoints ?? defaultTarget;
    setTarget(t != null ? String(t) : '');
    const sl = user?.stopLossPoints ?? user?.defaultStopLossPoints ?? defaultStopLoss;
    setStopLoss(sl != null ? String(sl) : '');
    setError(null);
  }, [show, user, defaultTarget, defaultStopLoss]);

  const save = async () => {
    const parse = (v: string): number | null | undefined => {
      if (v.trim() === '') return null; // blank = back to the platform default
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    if (fixed) { onHide(); return; }
    const tp = parse(target);
    const sl = parse(stopLoss);
    if (tp === undefined || sl === undefined) { setError('Target and stop loss must be numbers greater than 0 (or blank to go back to the platform default).'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/users/${encodeURIComponent(user!.email)}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(user?.investmentModeLocked ? {} : { investmentMode: mode }), targetPoints: tp, stopLossPoints: sl }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Failed to save');
      await refreshUser();
      onHide();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal show={show} onHide={onHide} centered>
      <Modal.Header closeButton><Modal.Title>Flash Trade settings</Modal.Title></Modal.Header>
      <Modal.Body>
        <Form.Group className="mb-3">
          <Form.Label className="fw-semibold">How many to buy</Form.Label>
          <Form.Select value={fixed ? 'investmentAmount' : mode} disabled={fixed || user?.investmentModeLocked === true} onChange={(e) => setMode(e.target.value as 'lotCount' | 'investmentAmount')}>
            <option value="lotCount">1 lot every time (65 for NIFTY, 20 for SENSEX)</option>
            <option value="investmentAmount">As many lots as my capital allows</option>
          </Form.Select>
          <Form.Text className="text-muted">{fixed ? 'Fixed for Beginner accounts. Advanced accounts can also choose 1 lot every time. ' : ''}{user?.investmentModeLocked ? 'Locked by an admin - contact them to change it. ' : ''}Your daily loss limit still applies in both choices.{mode === 'investmentAmount' && user?.role !== 'admin' ? ' In this mode you can place at most 3 trades a day.' : ''}</Form.Text>
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label className="fw-semibold">Target points</Form.Label>
          <Form.Control type="number" min="0" value={target} readOnly={fixed} onChange={(e) => setTarget(e.target.value)}
            placeholder="Target points" />
          <Form.Text className="text-muted">Sell automatically when the price rises by this many points. {fixed ? 'Fixed for Beginner accounts. Advanced accounts can set their own.' : 'Saved for your account.'}</Form.Text>
        </Form.Group>
        <Form.Group>
          <Form.Label className="fw-semibold">Stop loss points</Form.Label>
          <Form.Control type="number" min="0" value={stopLoss} readOnly={fixed} onChange={(e) => setStopLoss(e.target.value)}
            placeholder="Stop loss points" />
          <Form.Text className="text-muted">Sell automatically when the price falls by this many points. {fixed ? 'Fixed for Beginner accounts. Advanced accounts can set their own.' : 'Saved for your account.'}</Form.Text>
          {!fixed && levelRules && <Form.Text className="text-muted d-block">Your position is sized so one stopped-out trade cannot lose more than {levelRules.limits.advanced.perTrade}% of your capital.</Form.Text>}
        </Form.Group>
        {error && <Alert variant="danger" className="mt-3 mb-0 py-2">{error}</Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide} disabled={saving}>{fixed ? 'Close' : 'Cancel'}</Button>
        {!fixed && <Button variant="primary" onClick={save} disabled={saving}>{saving ? <Spinner animation="border" size="sm" /> : 'Save'}</Button>}
      </Modal.Footer>
    </Modal>
  );
}
