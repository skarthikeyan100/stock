import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Container, Card, Table, Form, Button, Spinner, Alert, Row, Col } from 'react-bootstrap';
import { apiFetch, readError } from '../utils/api';
import { periodEndShown } from '../utils/period';

type PaidTo = 'bank' | 'upi';

export default function PayoutPaymentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [paidTo, setPaidTo] = useState<PaidTo>('bank');
  const [paymentRef, setPaymentRef] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [emailResult, setEmailResult] = useState<{ emailStatus: string; emailError?: string } | null>(null);
  const [resending, setResending] = useState(false);

  const load = () => {
    setLoading(true);
    apiFetch(`/admin/payouts/${id}`)
      .then(async res => { if (!res.ok) throw new Error(await readError(res)); return res.json(); })
      .then(d => {
        setData(d);
        // Default to UPI only when the payee has no bank account on file.
        if (!d.payee.bankAccountNumber && d.payee.upiId) setPaidTo('upi');
      })
      .catch(e => setError(e.message || 'Failed to load payout'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const copy = (text?: string) => { if (text) navigator.clipboard?.writeText(text).catch(() => undefined); };

  const submit = async () => {
    if (submitting || !file) return;
    if (!window.confirm(`Confirm you have paid ₹${data.payout.netAmount.toFixed(2)} to ${data.payee.email}? This marks the payout PAID and emails the user. It cannot be undone.`)) return;
    setSubmitting(true);
    setError('');
    try {
      const form = new FormData();
      form.append('proof', file);
      form.append('paidTo', paidTo);
      form.append('paymentRef', paymentRef);
      form.append('note', note);
      const res = await apiFetch(`/admin/payouts/${id}/pay`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await readError(res));
      const result = await res.json();
      setEmailResult({ emailStatus: result.emailStatus, emailError: result.emailError });
      load();
    } catch (e: any) {
      setError(e.message || 'Failed to mark payout paid');
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    setResending(true);
    try {
      const res = await apiFetch(`/admin/payouts/${id}/resend-email`, { method: 'POST' });
      if (!res.ok) throw new Error(await readError(res));
      setEmailResult(await res.json());
      load();
    } catch (e: any) {
      setError(e.message || 'Failed to resend email');
    } finally {
      setResending(false);
    }
  };

  if (loading && !data) return <Container className="py-5 text-center"><Spinner animation="border" /></Container>;
  if (!data) return <Container className="py-4"><Alert variant="danger">{error || 'Payout not found'}</Alert><Button size="sm" onClick={() => navigate('/admin')}>Back</Button></Container>;

  const { payout, payee } = data;
  const pending = payout.status === 'pending';
  const hasDestination = paidTo === 'bank' ? !!(payee.bankAccountNumber && payee.bankIFSC) : !!payee.upiId;
  const snapshotAccountTail = payout.bankSnapshot?.accountNumberMasked?.slice(-4);
  const bankChanged = !!payee.bankAccountNumber && !!snapshotAccountTail && !payee.bankAccountNumber.endsWith(snapshotAccountTail);

  const Row2 = ({ label, value, copyable }: { label: string; value?: string; copyable?: boolean }) => (
    <tr>
      <td className="text-muted" style={{ width: 180 }}>{label}</td>
      <td>{value || '—'} {copyable && value && <Button size="sm" variant="link" className="p-0 ms-2" onClick={() => copy(value)}>copy</Button>}</td>
    </tr>
  );

  return (
    <Container className="py-4" style={{ maxWidth: 820 }}>
      <Button size="sm" variant="link" className="p-0 mb-2" onClick={() => navigate('/admin')}>&larr; Back to Admin</Button>
      <h4>Pay payout {payout.invoiceNumber}</h4>
      {error && <Alert variant="danger" dismissible onClose={() => setError('')}>{error}</Alert>}
      {!pending && <Alert variant={payout.status === 'paid' ? 'success' : 'secondary'}>This payout is <strong>{payout.status}</strong>.</Alert>}

      <Row className="g-3">
        <Col md={6}>
          <Card>
            <Card.Header className="fw-bold">Payout</Card.Header>
            <Table size="sm" className="mb-0"><tbody>
              <Row2 label="User" value={`${payee.name ?? ''} (${payee.email})`} />
              <Row2 label="Period" value={`${new Date(payout.periodStart).toLocaleDateString()} – ${periodEndShown(payout.periodEnd).toLocaleDateString()}`} />
              <Row2 label="Gross profit" value={`₹${payout.grossProfit.toFixed(2)}`} />
              <Row2 label={`Split (${payout.profitSplitPercent}%)`} value={`₹${payout.splitAmount.toFixed(2)}`} />
              <Row2 label="TDS" value={`₹${payout.tdsAmount.toFixed(2)}`} />
              <Row2 label="GST" value={`₹${payout.gstAmount.toFixed(2)}`} />
              <tr className="fw-bold"><td>Net to pay</td><td>₹{payout.netAmount.toFixed(2)} <Button size="sm" variant="link" className="p-0 ms-2" onClick={() => copy(payout.netAmount.toFixed(2))}>copy</Button></td></tr>
            </tbody></Table>
          </Card>
        </Col>
        <Col md={6}>
          <Card>
            <Card.Header className="fw-bold">Pay to</Card.Header>
            <Table size="sm" className="mb-0"><tbody>
              <Row2 label="Account holder" value={payee.bankAccountHolderName} copyable />
              <Row2 label="Account number" value={payee.bankAccountNumber} copyable />
              <Row2 label="IFSC" value={payee.bankIFSC} copyable />
              <Row2 label="UPI ID" value={payee.upiId} copyable />
            </tbody></Table>
            {bankChanged && <Alert variant="warning" className="m-2 mb-2 py-1 small">The user&apos;s bank account changed since this payout was created (was ****{snapshotAccountTail}). Double-check before paying.</Alert>}
          </Card>
        </Col>
      </Row>

      {pending && (
        <Card className="mt-3">
          <Card.Header className="fw-bold">Confirm payment</Card.Header>
          <Card.Body>
            <Form.Group className="mb-2">
              <Form.Label className="small">Paid via</Form.Label>
              <div>
                <Form.Check inline type="radio" label="Bank transfer" checked={paidTo === 'bank'} onChange={() => setPaidTo('bank')} />
                <Form.Check inline type="radio" label="UPI" checked={paidTo === 'upi'} onChange={() => setPaidTo('upi')} />
              </div>
            </Form.Group>
            {!hasDestination && <Alert variant="warning" className="py-1 small">The user has no {paidTo === 'bank' ? 'bank account/IFSC' : 'UPI ID'} on file.</Alert>}
            <Form.Group className="mb-2">
              <Form.Label className="small">Payment reference / UTR (optional)</Form.Label>
              <Form.Control size="sm" value={paymentRef} onChange={e => setPaymentRef(e.target.value)} />
            </Form.Group>
            <Form.Group className="mb-2">
              <Form.Label className="small">Note for the user (optional, shown in the email)</Form.Label>
              <Form.Control size="sm" value={note} onChange={e => setNote(e.target.value)} />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label className="small">Payment screenshot</Form.Label>
              <Form.Control size="sm" type="file" accept="image/*" onChange={e => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
              {preview && <img src={preview} alt="Payment proof preview" style={{ maxWidth: '100%', maxHeight: 320, marginTop: 8 }} />}
            </Form.Group>
            <Button variant="success" disabled={submitting || !file || !hasDestination} onClick={submit}>
              {submitting ? 'Saving…' : 'Mark paid & email user'}
            </Button>
          </Card.Body>
        </Card>
      )}

      {payout.status === 'paid' && (
        <Card className="mt-3">
          <Card.Body>
            <div>Paid {payout.paidAt ? new Date(payout.paidAt).toLocaleString() : ''} {payout.paymentRef && <>· ref {payout.paymentRef}</>}</div>
            <div className="mt-1">Email: <strong>{payout.emailStatus ?? 'unknown'}</strong>{(emailResult?.emailError || payout.emailError) && <span className="text-danger small"> — {emailResult?.emailError || payout.emailError}</span>}</div>
            {payout.emailStatus !== 'sent' && <Button size="sm" className="mt-2" variant="outline-primary" disabled={resending} onClick={resend}>{resending ? 'Sending…' : 'Resend email'}</Button>}
            {payout.proofFileId && <div className="mt-2"><a href={`/users/${encodeURIComponent(payout.user)}/payouts/${payout._id}/proof`} target="_blank" rel="noreferrer">View payment screenshot</a></div>}
          </Card.Body>
        </Card>
      )}
    </Container>
  );
}
