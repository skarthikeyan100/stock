import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Card, Form, Button, Badge, Alert, Spinner, Row, Col } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';

function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified
    ? <Badge bg="success" className="ms-2">Verified</Badge>
    : <Badge bg="secondary" className="ms-2">Pending</Badge>;
}

type DocType = 'address' | 'dob' | 'pan';

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [phone, setPhone] = useState(user?.phone ?? '');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSaved, setPhoneSaved] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);

  const [uploadStatus, setUploadStatus] = useState<Record<DocType, 'idle' | 'uploading' | 'done' | 'error'>>({
    address: 'idle', dob: 'idle', pan: 'idle',
  });
  const [uploadedIds, setUploadedIds] = useState<Record<DocType, string | undefined>>({
    address: user?.addressProofId,
    dob: user?.dobProofId,
    pan: user?.panCardId,
  });

  const addressRef = useRef<HTMLInputElement>(null);
  const dobRef = useRef<HTMLInputElement>(null);
  const panRef = useRef<HTMLInputElement>(null);

  const refMap: Record<DocType, React.RefObject<HTMLInputElement>> = {
    address: addressRef, dob: dobRef, pan: panRef,
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
        <VerifiedBadge verified={verified} />
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

  return (
    <div className="min-vh-100 bg-light">
      <div className="bg-dark bg-opacity-10 border-bottom">
        <Container className="py-2 d-flex justify-content-between align-items-center">
          <span className="fw-bold">My Profile</span>
          <div className="d-flex align-items-center gap-3">
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
                <VerifiedBadge verified={user?.emailVerified ?? false} />
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
                    <VerifiedBadge verified={user?.phoneVerified ?? false} />
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

        {/* KYC Documents */}
        <Card>
          <Card.Header className="fw-bold">KYC Documents</Card.Header>
          <Card.Body>
            <Alert variant="info" className="small py-2 mb-3">
              Upload PDF, JPG, or PNG files (max 5MB each). Documents are reviewed and verified by admin.
            </Alert>
            <DocRow docType="address" label="Address Proof" verified={false} />
            <DocRow docType="dob" label="Date of Birth Proof" verified={false} />
            <DocRow docType="pan" label="PAN Card" verified={false} isLast />
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
