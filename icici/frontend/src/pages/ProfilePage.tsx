import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Card, Form, Button, Badge, Alert, Spinner, Row, Col, Table } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';
import NotificationBell from '../components/NotificationBell';

function VerifiedBadge({ verified, hasValue }: { verified: boolean; hasValue: boolean }) {
  if (verified) return <Badge bg="success" className="ms-2">Verified</Badge>;
  if (hasValue) return <Badge bg="warning" text="dark" className="ms-2">Under Verification</Badge>;
  return <Badge bg="secondary" className="ms-2">Pending</Badge>;
}

// Same three states as VerifiedBadge, but a different color (blue, not amber)
// for the "has a value, not yet verified" case - this badge is about the
// OCR-extracted number specifically, not the document's own review status
// shown right above it, so it needs to look visually distinct from it.
function NumberBadge({ verified, hasValue }: { verified: boolean; hasValue: boolean }) {
  if (verified) return <Badge bg="success" className="me-2">Verified</Badge>;
  if (hasValue) return <Badge bg="info" text="dark" className="me-2">Extracted</Badge>;
  return <Badge bg="secondary" className="me-2">Pending</Badge>;
}

type DocType = 'pan' | 'aadhar' | 'gst';

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

function PayoutStatusBadge({ status }: { status: Payout['status'] }) {
  const variant = status === 'paid' ? 'success' : status === 'rejected' ? 'danger' : 'warning';
  return <Badge bg={variant} text={status === 'pending' ? 'dark' : undefined}>{status}</Badge>;
}

export default function ProfilePage() {
  const { user, logout, refreshUser } = useAuth();
  const navigate = useNavigate();

  const [phone, setPhone] = useState(user?.phone ?? '');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSaved, setPhoneSaved] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);

  const [investmentMode, setInvestmentMode] = useState<'lotCount' | 'investmentAmount'>(user?.investmentMode ?? 'investmentAmount');
  const [modeSaved, setModeSaved] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [entityType, setEntityType] = useState<'individual' | 'company'>(user?.entityType ?? 'individual');
  const [entityTypeSaving, setEntityTypeSaving] = useState(false);
  const [entityTypeError, setEntityTypeError] = useState<string | null>(null);
  const [gstin, setGstin] = useState(user?.gstin ?? '');
  const [companyName, setCompanyName] = useState(user?.companyRegisteredName ?? '');
  const [companySaving, setCompanySaving] = useState(false);
  const [companySaved, setCompanySaved] = useState(false);

  // PAN/Aadhaar numbers are OCR-extracted from the uploaded document, not
  // typed by the user (see uploadDocument) - this only tracks whether the
  // last upload failed to yield a readable number, so we can prompt for a
  // clearer photo instead of falling back to manual entry.
  const [needsClearerPhoto, setNeedsClearerPhoto] = useState<Record<'pan' | 'aadhar', boolean>>({
    pan: false, aadhar: false,
  });

  const [uploadStatus, setUploadStatus] = useState<Record<DocType, 'idle' | 'uploading' | 'done' | 'error'>>({
    pan: 'idle', aadhar: 'idle', gst: 'idle',
  });
  const [uploadedIds, setUploadedIds] = useState<Record<DocType, string | undefined>>({
    pan: user?.panCardId,
    aadhar: user?.aadharDocId,
    gst: user?.gstDocId,
  });
  const [uploadError, setUploadError] = useState<Partial<Record<DocType, string>>>({});

  const docVerified: Record<DocType, boolean> = {
    pan: user?.panVerified ?? false,
    aadhar: user?.aadharVerified ?? false,
    gst: user?.gstVerified ?? false,
  };

  const kycComplete =
    !!uploadedIds.pan && docVerified.pan &&
    !!uploadedIds.aadhar && docVerified.aadhar;

  const panRef = useRef<HTMLInputElement>(null);
  const aadharRef = useRef<HTMLInputElement>(null);
  const gstRef = useRef<HTMLInputElement>(null);

  const refMap: Record<DocType, React.RefObject<HTMLInputElement>> = {
    pan: panRef, aadhar: aadharRef, gst: gstRef,
  };

  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [payoutsLoading, setPayoutsLoading] = useState(true);

  const [holderName, setHolderName] = useState(user?.bankAccountHolderName ?? '');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState(user?.bankIFSC ?? '');
  const [upiId, setUpiId] = useState(user?.upiId ?? '');
  const [editingBank, setEditingBank] = useState(false);
  const [bankSaving, setBankSaving] = useState(false);
  const [bankSaved, setBankSaved] = useState(false);

  const [expandedPayoutId, setExpandedPayoutId] = useState<string | null>(null);
  const [decisionLogs, setDecisionLogs] = useState<Record<string, DecisionLogEntry[]>>({});

  useEffect(() => {
    if (!user) return;
    fetch(`/users/${encodeURIComponent(user.email)}/payouts`)
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setPayouts(data); })
      .catch(() => {})
      .finally(() => setPayoutsLoading(false));
  }, [user?.email]);

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

  const togglePayoutDetail = async (payout: Payout) => {
    if (expandedPayoutId === payout._id) { setExpandedPayoutId(null); return; }
    setExpandedPayoutId(payout._id);
    if (!decisionLogs[payout._id] && !user) return;
    if (!decisionLogs[payout._id]) {
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/payouts/${payout._id}/decision-log`);
      const data = await res.json();
      setDecisionLogs(prev => ({ ...prev, [payout._id]: data }));
    }
  };

  const pendingPayouts = payouts.filter(p => p.status === 'pending');

  const savePhone = async () => {
    setPhoneError(null);
    setPhoneSaved(false);
    if (phone && !/^\+?[\d\s\-()]{7,15}$/.test(phone)) {
      setPhoneError('Enter a valid phone number');
      return;
    }
    setPhoneSaving(true);
    try {
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setPhoneSaved(true);
      const t = setTimeout(() => setPhoneSaved(false), 3000);
      return () => clearTimeout(t);
    } catch {
      setPhoneError('Failed to save phone number');
    } finally {
      setPhoneSaving(false);
    }
  };

  const saveInvestmentMode = async () => {
    setModeError(null);
    setModeSaved(false);
    setModeSaving(true);
    try {
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ investmentMode }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setModeSaved(true);
      const t = setTimeout(() => setModeSaved(false), 3000);
      return () => clearTimeout(t);
    } catch {
      setModeError('Failed to save investment mode');
    } finally {
      setModeSaving(false);
    }
  };

  const saveEntityType = async (next: 'individual' | 'company') => {
    setEntityTypeError(null);
    setEntityTypeSaving(true);
    try {
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/entity-type`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update account type');
      }
      setEntityType(next);
    } catch (e: any) {
      setEntityTypeError(e.message);
    } finally {
      setEntityTypeSaving(false);
    }
  };

  const saveCompanyProfile = async () => {
    setCompanySaved(false);
    setCompanySaving(true);
    try {
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/company-profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gstin, companyRegisteredName: companyName }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setCompanySaved(true);
      setTimeout(() => setCompanySaved(false), 3000);
    } finally {
      setCompanySaving(false);
    }
  };

  const uploadDocument = async (docType: DocType, file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setUploadStatus(prev => ({ ...prev, [docType]: 'error' }));
      setUploadError(prev => ({ ...prev, [docType]: 'File is larger than 5MB' }));
      return;
    }
    setUploadStatus(prev => ({ ...prev, [docType]: 'uploading' }));
    setNeedsClearerPhoto(prev => ({ ...prev, [docType]: false }));
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/documents/${docType}`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Upload failed (server returned ${res.status})`);
      }
      const data = await res.json();
      setUploadedIds(prev => ({ ...prev, [docType]: data.id }));
      setUploadStatus(prev => ({ ...prev, [docType]: 'done' }));
      // PAN/Aadhaar numbers are read from the document itself via OCR (see
      // POST /users/:email/documents/:docType) - never typed by the user -
      // so refresh the session user to pick up the newly extracted number.
      if (docType === 'pan' || docType === 'aadhar') {
        if (!data.numberExtracted) {
          setNeedsClearerPhoto(prev => ({ ...prev, [docType]: true }));
        }
        await refreshUser();
      }
    } catch (e: any) {
      setUploadStatus(prev => ({ ...prev, [docType]: 'error' }));
      // A fetch() that never reached the server (server not running, no
      // network) throws a generic "Failed to fetch" TypeError, not an HTTP
      // error - surface that distinctly rather than implying the file itself
      // was rejected.
      setUploadError(prev => ({ ...prev, [docType]: e instanceof TypeError ? "Couldn't reach the server - is it running?" : e.message }));
    }
  };

  const DocRow = ({ docType, label, verified, isLast = false }: { docType: DocType; label: string; verified: boolean; isLast?: boolean }) => (
    <div className={`d-flex align-items-center justify-content-between py-2 ${isLast ? '' : 'border-bottom'}`}>
      <div>
        <span className="fw-semibold">{label}</span>
        <VerifiedBadge verified={verified} hasValue={!!uploadedIds[docType]} />
        {uploadedIds[docType] && <span className="ms-2 text-muted small">Uploaded</span>}
        {uploadStatus[docType] === 'error' && (
          <span className="ms-2 text-danger small">{uploadError[docType] || 'Upload failed'}</span>
        )}
      </div>
      <div className="d-flex align-items-center gap-2">
        {uploadStatus[docType] === 'uploading' && <Spinner animation="border" size="sm" />}
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          className="d-none"
          ref={refMap[docType]}
          onChange={e => { if (e.target.files?.[0]) uploadDocument(docType, e.target.files[0]); }}
        />
        <Button
          variant="outline-primary"
          size="sm"
          disabled={uploadStatus[docType] === 'uploading'}
          onClick={() => refMap[docType].current?.click()}
        >
          {uploadedIds[docType] ? 'Replace' : 'Upload'}
        </Button>
      </div>
    </div>
  );

  // PAN/Aadhar doc row plus the number OCR-extracted from it (see
  // uploadDocument) printed underneath - read-only by design, since it comes
  // from the document itself, never typed in, so it can't drift from what's
  // actually on the proof on file.
  const IdDocRow = ({ docType, label, numberLabel, masked, verified, isLast = false }: { docType: 'pan' | 'aadhar'; label: string; numberLabel: string; masked: string | undefined; verified: boolean; isLast?: boolean }) => (
    <div className={`py-2 ${isLast ? '' : 'border-bottom'}`}>
      <div className="d-flex align-items-center justify-content-between">
        <div>
          <span className="fw-semibold">{label}</span>
          <VerifiedBadge verified={verified} hasValue={!!uploadedIds[docType]} />
          {uploadedIds[docType] && <span className="ms-2 text-muted small">Uploaded</span>}
          {uploadStatus[docType] === 'error' && (
            <span className="ms-2 text-danger small">{uploadError[docType] || 'Upload failed'}</span>
          )}
        </div>
        <div className="d-flex align-items-center gap-2">
          {uploadStatus[docType] === 'uploading' && <Spinner animation="border" size="sm" />}
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            className="d-none"
            ref={refMap[docType]}
            onChange={e => { if (e.target.files?.[0]) uploadDocument(docType, e.target.files[0]); }}
          />
          <Button
            variant="outline-primary"
            size="sm"
            disabled={uploadStatus[docType] === 'uploading'}
            onClick={() => refMap[docType].current?.click()}
          >
            {uploadedIds[docType] ? 'Replace' : 'Upload'}
          </Button>
        </div>
      </div>
      <div className="mt-1">
        <NumberBadge verified={verified} hasValue={!!masked} />
        {masked ? (
          <span className="text-muted small">{numberLabel}: {masked}</span>
        ) : (
          <span className="text-muted small">
            {needsClearerPhoto[docType] ? `Couldn't read your ${numberLabel.toLowerCase()} clearly — please upload a clearer photo above` : `${numberLabel} will appear here once extracted`}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-vh-100 bg-light">
      <div className="bg-dark bg-opacity-10 border-bottom">
        <Container className="py-2 d-flex justify-content-between align-items-center">
          <span className="fw-bold">My Profile</span>
          <div className="d-flex align-items-center gap-3">
            <NotificationBell />
            <Button variant="outline-secondary" size="sm" onClick={() => navigate('/app/trade')}>← Trading</Button>
            <Button variant="outline-secondary" size="sm" onClick={logout}>Logout</Button>
          </div>
        </Container>
      </div>

      <Container className="py-4" style={{ maxWidth: 600 }}>
        <Alert variant="warning" className="small">
          <strong>PAN card is mandatory</strong> if your total payout exceeds &#8377;20,000 in a year. Please upload your PAN card in the KYC Documents section below.
        </Alert>

        <div className="d-flex align-items-center gap-3 mb-4">
          {user?.picture && <img src={user.picture} alt="" width={56} height={56} className="rounded-circle" />}
          <div>
            <div className="fw-bold fs-5">{user?.name}</div>
            <div className="text-muted small">{user?.email}</div>
          </div>
        </div>

        {/* Contact Info */}
        <Card className="mb-3">
          <Card.Header className="fw-bold">Contact Information</Card.Header>
          <Card.Body>
            <Form.Group className="mb-3">
              <Form.Label>Email</Form.Label>
              <div className="d-flex align-items-center gap-2">
                <Form.Control type="email" value={user?.email ?? ''} readOnly className="bg-light" />
                <VerifiedBadge verified={user?.emailVerified ?? false} hasValue={!!user?.email} />
              </div>
            </Form.Group>
            <Form.Group>
              <Form.Label>Phone</Form.Label>
              <Row className="g-2 align-items-center">
                <Col>
                  <div className="d-flex align-items-center gap-2">
                    <Form.Control
                      type="tel"
                      placeholder="+91 98765 43210"
                      value={phone}
                      onChange={e => setPhone(e.target.value)}
                      isInvalid={!!phoneError}
                    />
                    <VerifiedBadge verified={user?.phoneVerified ?? false} hasValue={!!phone} />
                  </div>
                  {phoneError && <div className="text-danger small mt-1">{phoneError}</div>}
                </Col>
                <Col xs="auto">
                  <Button variant="primary" size="sm" onClick={savePhone} disabled={phoneSaving}>
                    {phoneSaving ? <Spinner animation="border" size="sm" /> : 'Save'}
                  </Button>
                </Col>
              </Row>
              {phoneSaved && <div className="text-success small mt-1">Phone saved</div>}
            </Form.Group>
          </Card.Body>
        </Card>

        {/* Investment Mode */}
        <Card className="mb-3">
          <Card.Header className="fw-bold">Trading Mode</Card.Header>
          <Card.Body>
            <Form.Group className="mb-2">
              <Form.Label className="fw-semibold">Investment Mode</Form.Label>
              <Form.Select
                value={investmentMode}
                onChange={e => setInvestmentMode(e.target.value as 'lotCount' | 'investmentAmount')}
              >
                <option value="investmentAmount">Investment Amount</option>
                <option value="lotCount">Lot Count</option>
              </Form.Select>
            </Form.Group>

            {investmentMode === 'investmentAmount' ? (
              <Alert variant="info" className="small py-2 mb-3">
                <strong>Investment Amount mode:</strong> Each trade is sized to as many lots as your remaining capital (&#8377;{(user?.investmentAmount ?? 100000).toLocaleString()}) covers at the option's current price, rather than a fixed lot count. Your investment amount is set by an admin — contact them to change it.
              </Alert>
            ) : (
              <Alert variant="info" className="small py-2 mb-3">
                <strong>Lot Count mode:</strong> Each trade buys a fixed number of lots regardless of price. Multiple simultaneous positions are possible, and the system will average down if the price moves against you up to your configured lot limit.
              </Alert>
            )}
            {user?.perOrderCap !== undefined && (
              <div className="text-muted small mb-3">Per-order cap (admin-set): &#8377;{user.perOrderCap.toLocaleString()}</div>
            )}

            <div className="d-flex align-items-center gap-3">
              <Button variant="primary" size="sm" onClick={saveInvestmentMode} disabled={modeSaving}>
                {modeSaving ? <Spinner animation="border" size="sm" /> : 'Save Mode'}
              </Button>
              {modeSaved && <span className="text-success small">Investment mode saved</span>}
              {modeError && <span className="text-danger small">{modeError}</span>}
            </div>
          </Card.Body>
        </Card>

        {/* Account Type */}
        <Card className="mb-3">
          <Card.Header className="fw-bold">Account Type</Card.Header>
          <Card.Body>
            <Form.Check
              inline
              type="radio"
              name="entityType"
              id="entityType-individual"
              label="Individual"
              checked={entityType === 'individual'}
              disabled={entityTypeSaving}
              onChange={() => saveEntityType('individual')}
            />
            <Form.Check
              inline
              type="radio"
              name="entityType"
              id="entityType-company"
              label="Company"
              checked={entityType === 'company'}
              disabled={entityTypeSaving}
              onChange={() => saveEntityType('company')}
            />
            <div className="text-muted small mt-1">Locked after your first paid payout.</div>
            {entityTypeError && <div className="text-danger small mt-1">{entityTypeError}</div>}
            <div className="small mt-2">
              {entityType === 'individual' ? (
                <span>10% TDS is deducted from each payout, as required for individual accounts.</span>
              ) : (
                <span>Company accounts with a verified GST certificate are paid gross — no TDS deducted.</span>
              )}
            </div>

            {entityType === 'company' && (
              <div className="mt-3 pt-3 border-top">
                <Row className="g-2">
                  <Col md={12}>
                    <Form.Group className="mb-2">
                      <Form.Label className="small">Registered Name</Form.Label>
                      <Form.Control size="sm" value={companyName} onChange={e => setCompanyName(e.target.value)} />
                    </Form.Group>
                  </Col>
                  <Col md={12}>
                    <Form.Group className="mb-2">
                      <Form.Label className="small">GSTIN</Form.Label>
                      <div className="d-flex align-items-center gap-2">
                        <Form.Control size="sm" value={gstin} onChange={e => setGstin(e.target.value.toUpperCase())} style={{ maxWidth: 220 }} />
                        <VerifiedBadge verified={user?.gstVerified ?? false} hasValue={!!gstin} />
                      </div>
                    </Form.Group>
                  </Col>
                </Row>
                <div className="d-flex align-items-center gap-2 mb-3">
                  <Button size="sm" onClick={saveCompanyProfile} disabled={companySaving}>
                    {companySaving ? <Spinner animation="border" size="sm" /> : 'Save Company Details'}
                  </Button>
                  {companySaved && <span className="text-success small">Saved</span>}
                </div>
                <DocRow docType="gst" label="GST Certificate" verified={docVerified.gst} isLast />
              </div>
            )}
          </Card.Body>
        </Card>

        {/* KYC Documents */}
        <Card>
          <Card.Header className="fw-bold">
            KYC Documents &amp; Identity
            {kycComplete
              ? <Badge bg="success" className="ms-2">Complete</Badge>
              : (uploadedIds.pan || uploadedIds.aadhar)
                ? <Badge bg="warning" text="dark" className="ms-2">Under Verification</Badge>
                : <Badge bg="secondary" className="ms-2">Pending</Badge>
            }
          </Card.Header>
          <Card.Body>
            {kycComplete ? (
              <Alert variant="success" className="small py-2 mb-3">
                Your KYC is complete. All documents have been uploaded and verified.
              </Alert>
            ) : (
              <Alert variant="info" className="small py-2 mb-3">
                Upload PDF, JPG, or PNG files (max 5MB each). Documents are reviewed and verified by admin.
              </Alert>
            )}

            <IdDocRow docType="pan" label="PAN Card" numberLabel="PAN Number" masked={user?.panNumberMasked} verified={docVerified.pan} />
            <IdDocRow docType="aadhar" label="Aadhar Proof" numberLabel="Aadhar Number" masked={user?.aadharNumberMasked} verified={docVerified.aadhar} isLast />
          </Card.Body>
        </Card>

        {/* Payouts */}
        <Alert variant="info" className="small py-2 mt-3">
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

        {pendingPayouts.length > 0 && (
          <Card className="mb-3">
            <Card.Header className="fw-bold">Pending Payout</Card.Header>
            <Card.Body>
              {pendingPayouts.map(p => (
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
            {payoutsLoading ? (
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
                        <td><PayoutStatusBadge status={p.status} /></td>
                        <td>
                          {p.status === 'paid' ? (
                            <a href={`/users/${encodeURIComponent(user!.email)}/payouts/${p._id}/invoice`} target="_blank" rel="noreferrer">View</a>
                          ) : p.status === 'rejected' ? (
                            <Button size="sm" variant="link" className="p-0" onClick={() => togglePayoutDetail(p)}>why?</Button>
                          ) : '—'}
                        </td>
                      </tr>
                      {expandedPayoutId === p._id && (
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
