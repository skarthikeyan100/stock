import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Card, Form, Button, Badge, Alert, Spinner, Row, Col, Table } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';
import NotificationBell from '../components/NotificationBell';

interface Payout {
  _id: string;
  periodStart: string;
  periodEnd: string;
  grossProfit: number;
  splitAmount: number;
  tdsAmount: number;
  netAmount: number;
  status: 'pending' | 'paid' | 'rejected';
  adminNote?: string;
  invoiceNumber: string;
}

interface DecisionLogEntry {
  _id: string;
  type: string;
  reason: string;
  detail: {
    day?: string;
    dayPnL?: number;
    consistencyPercent?: number;
    consistencyLimit?: number;
    cumulativePnL?: number;
    trades?: { tsym: string; entryPrice: number; exitPrice: number; quantity: number; realizedPnL: number }[];
  };
}

function StatusBadge({ status }: { status: Payout['status'] }) {
  const variant = status === 'paid' ? 'success' : status === 'rejected' ? 'danger' : 'warning';
  return <Badge bg={variant} text={status === 'pending' ? 'dark' : undefined}>{status}</Badge>;
}

export default function PayoutsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);

  const [holderName, setHolderName] = useState(user?.bankAccountHolderName ?? '');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState(user?.bankIFSC ?? '');
  const [upiId, setUpiId] = useState(user?.upiId ?? '');
  const [editingBank, setEditingBank] = useState(false);
  const [bankSaving, setBankSaving] = useState(false);
  const [bankSaved, setBankSaved] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decisionLogs, setDecisionLogs] = useState<Record<string, DecisionLogEntry[]>>({});

  const fetchPayouts = () => {
    if (!user) return;
    fetch(`/users/${encodeURIComponent(user.email)}/payouts`)
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setPayouts(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPayouts(); }, [user?.email]);

  const saveBankDetails = async () => {
    if (!user) return;
    setBankSaving(true);
    setBankSaved(false);
    try {
      await fetch(`/users/${encodeURIComponent(user.email)}/bank-details`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankAccountHolderName: holderName,
          bankAccountNumber: accountNumber || undefined,
          bankIFSC: ifsc,
          upiId,
        }),
      });
      setBankSaved(true);
      setEditingBank(false);
      setTimeout(() => setBankSaved(false), 3000);
    } finally {
      setBankSaving(false);
    }
  };

  const toggleDetail = async (payout: Payout) => {
    if (expandedId === payout._id) { setExpandedId(null); return; }
    setExpandedId(payout._id);
    if (!decisionLogs[payout._id] && !user) return;
    if (!decisionLogs[payout._id]) {
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/payouts/${payout._id}/decision-log`);
      const data = await res.json();
      setDecisionLogs(prev => ({ ...prev, [payout._id]: data }));
    }
  };

  const pending = payouts.filter(p => p.status === 'pending');

  return (
    <div className="min-vh-100 bg-light">
      <div className="bg-dark bg-opacity-10 border-bottom">
        <Container className="py-2 d-flex justify-content-between align-items-center">
          <span className="fw-bold">My Payouts</span>
          <div className="d-flex align-items-center gap-3">
            <NotificationBell />
            <Button variant="outline-secondary" size="sm" onClick={() => navigate('/app/trade')}>← Trading</Button>
            <Button variant="outline-secondary" size="sm" onClick={() => navigate('/app/profile')}>Profile</Button>
            <Button variant="outline-secondary" size="sm" onClick={logout}>Logout</Button>
          </div>
        </Container>
      </div>

      <Container className="py-4" style={{ maxWidth: 800 }}>
        <Alert variant="info" className="small py-2">
          Payouts are processed periodically, subject to a minimum profit cushion (safety buffer) on your first payout
          and a consistency rule limiting how much a single day may contribute to a payout period.
        </Alert>

        <Card className="mb-3">
          <Card.Header className="fw-bold d-flex justify-content-between align-items-center">
            Bank Details
            {!editingBank && <Button size="sm" variant="outline-primary" onClick={() => setEditingBank(true)}>Edit</Button>}
          </Card.Header>
          <Card.Body>
            {editingBank ? (
              <>
                <Row className="g-2">
                  <Col md={6}>
                    <Form.Group className="mb-2">
                      <Form.Label className="small">Account Holder Name</Form.Label>
                      <Form.Control size="sm" value={holderName} onChange={e => setHolderName(e.target.value)} />
                    </Form.Group>
                  </Col>
                  <Col md={6}>
                    <Form.Group className="mb-2">
                      <Form.Label className="small">Account Number</Form.Label>
                      <Form.Control size="sm" placeholder={user?.bankAccountNumberMasked || 'Enter account number'} value={accountNumber} onChange={e => setAccountNumber(e.target.value)} />
                    </Form.Group>
                  </Col>
                  <Col md={6}>
                    <Form.Group className="mb-2">
                      <Form.Label className="small">IFSC</Form.Label>
                      <Form.Control size="sm" value={ifsc} onChange={e => setIfsc(e.target.value.toUpperCase())} />
                    </Form.Group>
                  </Col>
                  <Col md={6}>
                    <Form.Group className="mb-2">
                      <Form.Label className="small">UPI ID</Form.Label>
                      <Form.Control size="sm" value={upiId} onChange={e => setUpiId(e.target.value)} />
                    </Form.Group>
                  </Col>
                </Row>
                <div className="d-flex gap-2 align-items-center">
                  <Button size="sm" onClick={saveBankDetails} disabled={bankSaving}>
                    {bankSaving ? <Spinner animation="border" size="sm" /> : 'Save'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditingBank(false)}>Cancel</Button>
                </div>
              </>
            ) : (
              <div className="small">
                <div><span className="text-muted">Account Holder:</span> {user?.bankAccountHolderName || '—'}</div>
                <div><span className="text-muted">Account:</span> {user?.bankAccountNumberMasked || '—'}</div>
                <div><span className="text-muted">IFSC:</span> {user?.bankIFSC || '—'} &nbsp; <span className="text-muted">UPI:</span> {user?.upiId || '—'}</div>
                {bankSaved && <div className="text-success mt-1">Bank details saved</div>}
              </div>
            )}
          </Card.Body>
        </Card>

        {pending.length > 0 && (
          <Card className="mb-3">
            <Card.Header className="fw-bold">Pending Payout</Card.Header>
            <Card.Body>
              {pending.map(p => (
                <div key={p._id} className="small">
                  Period: {new Date(p.periodStart).toDateString()} – {new Date(p.periodEnd).toDateString()} &nbsp;
                  Gross: ₹{p.grossProfit.toFixed(2)} &nbsp;
                  <Badge bg="warning" text="dark">Pending Review</Badge>
                </div>
              ))}
            </Card.Body>
          </Card>
        )}

        <Card>
          <Card.Header className="fw-bold">Payout History</Card.Header>
          <Card.Body className="p-0">
            {loading ? (
              <div className="text-center py-4"><Spinner animation="border" /></div>
            ) : payouts.length === 0 ? (
              <p className="text-center text-muted py-4 mb-0">No payouts yet.</p>
            ) : (
              <Table striped hover responsive className="mb-0">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Gross</th>
                    <th>TDS</th>
                    <th>Net</th>
                    <th>Status</th>
                    <th>Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map(p => (
                    <>
                      <tr key={p._id}>
                        <td>{new Date(p.periodStart).toLocaleDateString()} – {new Date(p.periodEnd).toLocaleDateString()}</td>
                        <td>₹{p.grossProfit.toFixed(2)}</td>
                        <td>₹{p.tdsAmount.toFixed(2)}</td>
                        <td>₹{p.netAmount.toFixed(2)}</td>
                        <td><StatusBadge status={p.status} /></td>
                        <td>
                          {p.status === 'paid' ? (
                            <a href={`/users/${encodeURIComponent(user!.email)}/payouts/${p._id}/invoice`} target="_blank" rel="noreferrer">View</a>
                          ) : p.status === 'rejected' ? (
                            <Button size="sm" variant="link" className="p-0" onClick={() => toggleDetail(p)}>why?</Button>
                          ) : '—'}
                        </td>
                      </tr>
                      {expandedId === p._id && (
                        <tr>
                          <td colSpan={6} className="bg-light">
                            {!decisionLogs[p._id] ? (
                              <Spinner animation="border" size="sm" />
                            ) : decisionLogs[p._id].length === 0 ? (
                              <span className="text-muted small">No details recorded.</span>
                            ) : (
                              decisionLogs[p._id].map(entry => (
                                <div key={entry._id} className="small mb-2">
                                  <div className="fw-semibold">{entry.reason}</div>
                                  {entry.detail?.day && (
                                    <div className="text-muted">
                                      Day: {entry.detail.day} — P&amp;L ₹{entry.detail.dayPnL?.toFixed(2)}
                                      {entry.detail.consistencyPercent !== undefined && (
                                        <> ({entry.detail.consistencyPercent.toFixed(0)}% of period profit, limit {entry.detail.consistencyLimit}%)</>
                                      )}
                                    </div>
                                  )}
                                  {entry.detail?.trades && entry.detail.trades.length > 0 && (
                                    <Table size="sm" borderless className="mt-1 mb-0">
                                      <thead>
                                        <tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>Qty</th><th>P&amp;L</th></tr>
                                      </thead>
                                      <tbody>
                                        {entry.detail.trades.map((t, i) => (
                                          <tr key={i}>
                                            <td>{t.tsym}</td>
                                            <td>₹{t.entryPrice}</td>
                                            <td>₹{t.exitPrice}</td>
                                            <td>{t.quantity}</td>
                                            <td>₹{t.realizedPnL?.toFixed(2)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </Table>
                                  )}
                                </div>
                              ))
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </Table>
            )}
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
