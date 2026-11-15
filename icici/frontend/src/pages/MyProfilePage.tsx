import { FormEvent, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row } from 'react-bootstrap';
import ContractorLayout from '../components/ContractorLayout';
import { useAuth } from '../context/AuthContext';
import { apiPost, readError } from '../utils/api';

// A contractor's own profile: masked KYC, the agreement, SEBI registration (Business), and requests to change bank / PAN / GSTIN (owner approves).
export default function MyProfilePage() {
  const { user, refreshUser } = useAuth();
  const [agree, setAgree] = useState({ a: false, d: false, r: false });
  const [sebi, setSebi] = useState({ number: '', validUntil: '' });
  const [chg, setChg] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string; where: string } | null>(null);
  if (!user) return null;
  const business = user.type === 'BUSINESS';
  const k = user.kyc ?? {};
  const note = (where: string, ok: boolean, text: string) => setMsg({ where, ok, text });

  const acceptNew = async (e: FormEvent) => {
    e.preventDefault();
    const res = await apiPost('/contractor/accept-agreement', { acceptTerms: agree.a, dpdpConsent: agree.d, representation6A5: agree.r });
    if (!res.ok) { note('agree', false, await readError(res)); return; }
    await refreshUser(); note('agree', true, 'Accepted.');
  };
  const saveSebi = async (e: FormEvent) => {
    e.preventDefault();
    const res = await apiPost('/contractor/sebi', { number: sebi.number, validUntil: sebi.validUntil });
    if (!res.ok) { note('sebi', false, await readError(res)); return; }
    await refreshUser(); note('sebi', true, 'Recorded. The owner will verify it.');
  };
  const askChange = async (e: FormEvent) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(chg).filter(([, v]) => v.trim() !== ''));
    const res = await apiPost('/contractor/kyc-change', body);
    if (!res.ok) { note('chg', false, await readError(res)); return; }
    setChg({}); note('chg', true, 'Sent. Your current details stay in use until the owner approves the change.');
  };
  const row = (label: string, v: any) => v ? <Row className="mb-1"><Col sm={4} className="text-muted small">{label}</Col><Col sm={8}>{v}</Col></Row> : null;
  const needAccept = user.agreementVersion !== user.agreementVersionRequired;

  return (
    <ContractorLayout>
      <Row className="g-3">
        <Col lg={6}>
          <Card className="mb-3">
            <Card.Header>Profile <Badge bg="secondary" className="ms-2">{user.status}</Badge></Card.Header>
            <Card.Body>
              {row('Name', user.name)}{row('Email', user.email)}{row('Agreement', business ? 'Business (GSTIN)' : 'Individual (PAN)')}
              {row(business ? 'Entity' : 'Legal name', k.legalName)}{row('Address', k.address)}{row('PAN', k.panMasked)}{row('GSTIN', k.gstinMasked)}
              {row('Bank account', k.bankAccountMasked)}{row('IFSC', k.bankIfsc)}{row('Account holder', k.bankHolder)}
              {business && row('Signatory', k.signatoryName ? `${k.signatoryName}, ${k.signatoryDesignation}` : '')}
            </Card.Body>
          </Card>
          <Card className="mb-3">
            <Card.Header>Change bank / tax details</Card.Header>
            <Card.Body>
              <p className="small text-muted">A change takes effect only after the owner approves it. Leave a field empty to keep it.</p>
              <Form onSubmit={askChange}>
                <Row className="g-2">
                  <Col md={6}><Form.Control placeholder="Bank account number" value={chg.bankAccount ?? ''} onChange={(e) => setChg({ ...chg, bankAccount: e.target.value })} /></Col>
                  <Col md={6}><Form.Control placeholder="IFSC" value={chg.bankIfsc ?? ''} onChange={(e) => setChg({ ...chg, bankIfsc: e.target.value })} /></Col>
                  <Col md={6}><Form.Control placeholder="PAN" value={chg.pan ?? ''} onChange={(e) => setChg({ ...chg, pan: e.target.value })} /></Col>
                  {business && <Col md={6}><Form.Control placeholder="GSTIN" value={chg.gstin ?? ''} onChange={(e) => setChg({ ...chg, gstin: e.target.value })} /></Col>}
                </Row>
                <Button type="submit" size="sm" className="mt-2" variant="outline-primary">Request change</Button>
                {msg?.where === 'chg' && <div className={`small mt-2 ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</div>}
              </Form>
            </Card.Body>
          </Card>
        </Col>
        <Col lg={6}>
          <Card className="mb-3">
            <Card.Header>Agreement</Card.Header>
            <Card.Body>
              <div className="mb-2">Accepted: v{user.agreementVersion ?? '–'} · In force: v{user.agreementVersionRequired}</div>
              <a href="/contractor/agreement" target="_blank" rel="noreferrer">Open the agreement (PDF)</a>
              {needAccept && (
                <Form onSubmit={acceptNew} className="mt-3">
                  <Alert variant="warning" className="small">A newer agreement is in force. Please read and accept it.</Alert>
                  <Form.Check id="a" checked={agree.a} onChange={(e) => setAgree({ ...agree, a: e.target.checked })} label={`I have read and accept the Forecasting Services Agreement v${user.agreementVersionRequired}`} />
                  <Form.Check id="d" checked={agree.d} onChange={(e) => setAgree({ ...agree, d: e.target.checked })} label="I consent to the data processing in Section 12." />
                  {business && <Form.Check id="r" checked={agree.r} onChange={(e) => setAgree({ ...agree, r: e.target.checked })} label="I confirm clause 6A.5 (registration and compliance)." />}
                  <Button type="submit" size="sm" className="mt-2" disabled={!agree.a || !agree.d || (business && !agree.r)}>Accept</Button>
                  {msg?.where === 'agree' && <div className={`small mt-2 ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</div>}
                </Form>
              )}
            </Card.Body>
          </Card>
          {business && (
            <Card className="mb-3">
              <Card.Header>SEBI Registration No.</Card.Header>
              <Card.Body>
                {user.sebi ? <div className="mb-2">{user.sebi.number} · valid until {user.sebi.validUntil} · {user.sebi.verified ? <Badge bg="success">verified</Badge> : <Badge bg="warning" text="dark">awaiting verification</Badge>}</div> : <div className="mb-2 text-muted">Not recorded.</div>}
                <Form onSubmit={saveSebi}>
                  <Row className="g-2">
                    <Col md={6}><Form.Control placeholder="INH000000000" maxLength={12} value={sebi.number} onChange={(e) => setSebi({ ...sebi, number: e.target.value.toUpperCase() })} required /></Col>
                    <Col md={6}><Form.Control type="date" value={sebi.validUntil} onChange={(e) => setSebi({ ...sebi, validUntil: e.target.value })} required /></Col>
                  </Row>
                  <Button type="submit" size="sm" className="mt-2" variant="outline-primary">{user.sebi ? 'Update' : 'Save'}</Button>
                  {msg?.where === 'sebi' && <div className={`small mt-2 ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</div>}
                </Form>
                <div className="small text-muted mt-2">Research Analyst registration (INH). Changing it needs the owner to verify it again.</div>
              </Card.Body>
            </Card>
          )}
        </Col>
      </Row>
    </ContractorLayout>
  );
}
