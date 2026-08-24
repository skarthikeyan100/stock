import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Card, Form, Button, Badge, Alert, Spinner, Row, Col } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';
import NotificationBell from '../components/NotificationBell';

function VerifiedBadge({ verified, hasValue }: { verified: boolean; hasValue: boolean }) {
  if (verified) return <Badge bg="success" className="ms-2">Verified</Badge>;
  if (hasValue) return <Badge bg="warning" text="dark" className="ms-2">Under Verification</Badge>;
  return <Badge bg="secondary" className="ms-2">Pending</Badge>;
}

type DocType = 'address' | 'dob' | 'pan' | 'aadhar' | 'gst';

const AADHAR_PATTERN = /^\d{12}$/;
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [phone, setPhone] = useState(user?.phone ?? '');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSaved, setPhoneSaved] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);

  const [legalName, setLegalName] = useState(user?.legalName ?? '');
  const [legalNameSaved, setLegalNameSaved] = useState(false);
  const [legalNameSaving, setLegalNameSaving] = useState(false);

  const [investmentMode, setInvestmentMode] = useState<'lotCount' | 'investmentAmount'>(user?.investmentMode ?? 'investmentAmount');
  const [modeSaved, setModeSaved] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [entityType, setEntityType] = useState<'individual' | 'company'>(user?.entityType ?? 'individual');
  const [entityTypeSaving, setEntityTypeSaving] = useState(false);
  const [entityTypeError, setEntityTypeError] = useState<string | null>(null);
  const [gstin, setGstin] = useState(user?.gstin ?? '');
  const [companyName, setCompanyName] = useState(user?.companyRegisteredName ?? '');
  const [companyAddress, setCompanyAddress] = useState(user?.companyRegisteredAddress ?? '');
  const [companySaving, setCompanySaving] = useState(false);
  const [companySaved, setCompanySaved] = useState(false);

  const [editingNumber, setEditingNumber] = useState<'aadharNumber' | 'panNumber' | null>(null);
  const [numberInput, setNumberInput] = useState('');
  const [numberError, setNumberError] = useState<string | null>(null);
  const [numberSaving, setNumberSaving] = useState(false);

  const [uploadStatus, setUploadStatus] = useState<Record<DocType, 'idle' | 'uploading' | 'done' | 'error'>>({
    address: 'idle', dob: 'idle', pan: 'idle', aadhar: 'idle', gst: 'idle',
  });
  const [uploadedIds, setUploadedIds] = useState<Record<DocType, string | undefined>>({
    address: user?.addressProofId,
    dob: user?.dobProofId,
    pan: user?.panCardId,
    aadhar: user?.aadharDocId,
    gst: user?.gstDocId,
  });

  const docVerified: Record<DocType, boolean> = {
    address: user?.addressVerified ?? false,
    dob: user?.dobVerified ?? false,
    pan: user?.panVerified ?? false,
    aadhar: user?.aadharVerified ?? false,
    gst: user?.gstVerified ?? false,
  };

  const kycComplete =
    !!uploadedIds.address && docVerified.address &&
    !!uploadedIds.dob && docVerified.dob &&
    !!uploadedIds.pan && docVerified.pan;

  const addressRef = useRef<HTMLInputElement>(null);
  const dobRef = useRef<HTMLInputElement>(null);
  const panRef = useRef<HTMLInputElement>(null);
  const aadharRef = useRef<HTMLInputElement>(null);
  const gstRef = useRef<HTMLInputElement>(null);

  const refMap: Record<DocType, React.RefObject<HTMLInputElement>> = {
    address: addressRef, dob: dobRef, pan: panRef, aadhar: aadharRef, gst: gstRef,
  };

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

  const saveLegalName = async () => {
    setLegalNameSaved(false);
    setLegalNameSaving(true);
    try {
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legalName }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setLegalNameSaved(true);
      setTimeout(() => setLegalNameSaved(false), 3000);
    } finally {
      setLegalNameSaving(false);
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
        body: JSON.stringify({ gstin, companyRegisteredName: companyName, companyRegisteredAddress: companyAddress }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setCompanySaved(true);
      setTimeout(() => setCompanySaved(false), 3000);
    } finally {
      setCompanySaving(false);
    }
  };

  const startEditNumber = (field: 'aadharNumber' | 'panNumber') => {
    setEditingNumber(field);
    setNumberInput('');
    setNumberError(null);
  };

  const saveNumber = async () => {
    if (!editingNumber) return;
    setNumberError(null);
    const value = editingNumber === 'panNumber' ? numberInput.toUpperCase() : numberInput;
    const pattern = editingNumber === 'aadharNumber' ? AADHAR_PATTERN : PAN_PATTERN;
    const hint = editingNumber === 'aadharNumber' ? 'Aadhar must be exactly 12 digits' : 'PAN must match the format AAAAA9999A';
    if (!pattern.test(value)) {
      setNumberError(hint);
      return;
    }
    setNumberSaving(true);
    try {
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/kyc-numbers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [editingNumber]: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save');
      }
      setEditingNumber(null);
    } catch (e: any) {
      setNumberError(e.message);
    } finally {
      setNumberSaving(false);
    }
  };

  const uploadDocument = async (docType: DocType, file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setUploadStatus(prev => ({ ...prev, [docType]: 'error' }));
      return;
    }
    setUploadStatus(prev => ({ ...prev, [docType]: 'uploading' }));
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/users/${encodeURIComponent(user!.email)}/documents/${docType}`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      setUploadedIds(prev => ({ ...prev, [docType]: data.id }));
      setUploadStatus(prev => ({ ...prev, [docType]: 'done' }));
    } catch {
      setUploadStatus(prev => ({ ...prev, [docType]: 'error' }));
    }
  };

  const DocRow = ({ docType, label, verified, isLast = false }: { docType: DocType; label: string; verified: boolean; isLast?: boolean }) => (
    <div className={`d-flex align-items-center justify-content-between py-2 ${isLast ? '' : 'border-bottom'}`}>
      <div>
        <span className="fw-semibold">{label}</span>
        <VerifiedBadge verified={verified} hasValue={!!uploadedIds[docType]} />
        {uploadedIds[docType] && <span className="ms-2 text-muted small">Uploaded</span>}
        {uploadStatus[docType] === 'error' && (
          <span className="ms-2 text-danger small">Failed (max 5MB, PDF/JPG/PNG)</span>
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

  const NumberRow = ({ field, label, masked, verified }: { field: 'aadharNumber' | 'panNumber'; label: string; masked: string | undefined; verified: boolean }) => (
    <div className="d-flex align-items-center justify-content-between py-2 border-bottom">
      {editingNumber === field ? (
        <div className="d-flex align-items-center gap-2 w-100">
          <Form.Control
            size="sm"
            value={numberInput}
            placeholder={field === 'aadharNumber' ? '12-digit Aadhar number' : 'AAAAA9999A'}
            onChange={e => setNumberInput(e.target.value)}
            isInvalid={!!numberError}
            style={{ maxWidth: 220 }}
          />
          <Button size="sm" onClick={saveNumber} disabled={numberSaving}>
            {numberSaving ? <Spinner animation="border" size="sm" /> : 'Save'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditingNumber(null)}>Cancel</Button>
          {numberError && <div className="text-danger small">{numberError}</div>}
        </div>
      ) : (
        <>
          <div>
            <span className="fw-semibold">{label}</span>
            <VerifiedBadge verified={verified} hasValue={!!masked} />
            {masked && <span className="ms-2 text-muted small">{masked}</span>}
          </div>
          <Button variant="outline-primary" size="sm" onClick={() => startEditNumber(field)}>
            {masked ? 'Edit' : 'Add'}
          </Button>
        </>
      )}
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
            <Button variant="outline-secondary" size="sm" onClick={() => navigate('/app/payouts')}>Payouts</Button>
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
                <strong>Investment Amount mode:</strong> Each trade uses your entire allocated capital (&#8377;{(user?.investmentAmount ?? 100000).toLocaleString()}) to buy the maximum possible quantity. Only one trade runs at a time — the system finds the best-priced contract that fits within your capital.
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
                      <Form.Label className="small">Registered Address</Form.Label>
                      <Form.Control size="sm" as="textarea" rows={2} value={companyAddress} onChange={e => setCompanyAddress(e.target.value)} />
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
              : (uploadedIds.address || uploadedIds.dob || uploadedIds.pan)
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

            <div className="d-flex align-items-center justify-content-between py-2 border-bottom">
              <Form.Group className="w-100">
                <Form.Label className="small mb-1">Legal Name</Form.Label>
                <div className="d-flex align-items-center gap-2">
                  <Form.Control size="sm" value={legalName} onChange={e => setLegalName(e.target.value)} style={{ maxWidth: 260 }} />
                  <Button size="sm" onClick={saveLegalName} disabled={legalNameSaving}>
                    {legalNameSaving ? <Spinner animation="border" size="sm" /> : 'Save'}
                  </Button>
                  {legalNameSaved && <span className="text-success small">Saved</span>}
                </div>
                <div className="text-muted" style={{ fontSize: '0.75rem' }}>May differ from your Google account name shown above.</div>
              </Form.Group>
            </div>

            <NumberRow field="panNumber" label="PAN Number" masked={user?.panNumberMasked} verified={docVerified.pan} />
            <NumberRow field="aadharNumber" label="Aadhar Number" masked={user?.aadharNumberMasked} verified={docVerified.aadhar} />

            <DocRow docType="pan" label="PAN Card" verified={docVerified.pan} />
            <DocRow docType="aadhar" label="Aadhar Proof" verified={docVerified.aadhar} />
            <DocRow docType="address" label="Address Proof" verified={docVerified.address} />
            <DocRow docType="dob" label="Date of Birth Proof" verified={docVerified.dob} isLast />
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
