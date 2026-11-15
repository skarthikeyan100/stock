import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row } from 'react-bootstrap';
import ContractorLayout from '../components/ContractorLayout';
import { useAuth } from '../context/AuthContext';
import { apiFetch, apiPost, readError } from '../utils/api';

interface Stmt { id: string; kind: string; periodFrom: string; periodTo: string; gross: number; status: string; utr: string | null; paidAt: string | null; invoiceDueAt: string | null; invoice: { number: string; date: string } | null }

// My fee statements (approved by the owner), a CSV of each, and for Business contractors the invoice upload for a paid statement.
function Statements({ business }: { business: boolean }) {
  const [rows, setRows] = useState<Stmt[]>([]);
  const [err, setErr] = useState('');
  const load = useCallback(() => apiFetch('/contractor/statements').then((r) => (r.ok ? r.json() : [])).then(setRows).catch(() => undefined), []);
  useEffect(() => { load(); }, [load]);
  const upload = async (e: FormEvent<HTMLFormElement>, id: string) => {
    e.preventDefault(); setErr('');
    const r = await apiFetch(`/contractor/statements/${id}/invoice`, { method: 'POST', body: new FormData(e.currentTarget) });
    if (!r.ok) { setErr(await readError(r)); return; }
    load();
  };
  return (
    <Card className="mb-3">
      <Card.Header>Statements</Card.Header>
      <Card.Body>
        {rows.length === 0 && <div className="text-muted">No statements yet.</div>}
        {rows.map((s) => (
          <div key={s.id} className="border-bottom py-2">
            <div className="d-flex justify-content-between flex-wrap gap-2">
              <span>{s.periodFrom} to {s.periodTo} · {s.kind.replace(/_/g, ' ').toLowerCase()}</span>
              <span><strong>₹{s.gross.toLocaleString('en-IN')}</strong> <Badge bg={s.status === 'PAID' ? 'success' : 'info'}>{s.status.toLowerCase()}</Badge> <a href={`/contractor/statements/${s.id}/csv`}>CSV</a></span>
            </div>
            {s.utr && <div className="small text-muted">Paid {s.paidAt ? new Date(s.paidAt).toLocaleDateString('en-IN') : ''}, UTR {s.utr}</div>}
            {business && s.invoiceDueAt && !s.invoice && (
              <Form onSubmit={(e) => upload(e, s.id)} className="mt-2">
                <div className="small mb-1">Invoice due by {new Date(s.invoiceDueAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST</div>
                <Row className="g-2">
                  <Col md={3}><Form.Control name="number" placeholder="Invoice number" required /></Col>
                  <Col md={3}><Form.Control name="date" type="date" required /></Col>
                  <Col md={4}><Form.Control name="invoice" type="file" accept="application/pdf" required /></Col>
                  <Col md={2}><Button type="submit" size="sm">Upload</Button></Col>
                </Row>
              </Form>
            )}
            {s.invoice && <div className="small text-success">Invoice {s.invoice.number} received.</div>}
          </div>
        ))}
        {err && <div className="text-danger small mt-2">{err}</div>}
      </Card.Body>
    </Card>
  );
}

// Details that were optional at acceptance: filled in here. Bank details can be set once; a later change waits for the owner.
function CompleteProfile({ business, missing, hasBank, onDone }: { business: boolean; missing: string[]; hasBank: boolean; onDone: () => Promise<void> }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (missing.length === 0) return null;
  const set = (k: string) => (e: React.ChangeEvent<any>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim() !== ''));
    const res = await apiPost('/contractor/profile', body);
    if (!res.ok) { setMsg({ ok: false, text: await readError(res) }); return; }
    setV({}); setMsg({ ok: true, text: 'Saved.' }); await onDone();
  };
  const inp = (k: string, ph: string, col = 6) => <Col md={col}><Form.Control placeholder={ph} value={v[k] ?? ''} onChange={set(k)} /></Col>;
  return (
    <Card className="mb-3 border-warning">
      <Card.Header>Complete your profile <span className="small text-muted ms-2">Still needed: {missing.join(', ')}</span></Card.Header>
      <Card.Body>
        <Form onSubmit={save}>
          <Row className="g-2">
            {business ? <>{inp('entityName', 'Legal entity name')}{inp('analystName', 'Research Analyst name')}</> : inp('legalName', 'Full legal name')}
            {inp('address', business ? 'Registered address' : 'Address', 12)}
            {!hasBank && <>{inp('bankHolder', 'Bank account holder name')}{inp('bankAccount', 'Bank account number')}{inp('bankIfsc', 'IFSC')}</>}
          </Row>
          <Button type="submit" size="sm" className="mt-2">Save</Button>
          {msg && <span className={`small ms-2 ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</span>}
        </Form>
        {business && missing.includes('SEBI registration') && <div className="small text-muted mt-2">Add your SEBI Registration No. in the box below; you cannot submit recommendations until it is recorded and verified.</div>}
      </Card.Body>
    </Card>
  );
}

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
              {business && row('Research Analyst', k.analystName)}
            </Card.Body>
          </Card>
          <CompleteProfile business={business} missing={(user.missingDetails as string[] | undefined) ?? []} hasBank={!!k.bankAccountMasked} onDone={refreshUser} />
          <Statements business={business} />
          <Card className="mb-3">
            <Card.Header>Change bank / tax details</Card.Header>
            <Card.Body>
              <p className="small text-muted">A change takes effect only after the owner approves it. Leave a field empty to keep it.</p>
              <Form onSubmit={askChange}>
                <Row className="g-2">
                  <Col md={6}><Form.Control placeholder="Bank account number" value={chg.bankAccount ?? ''} onChange={(e) => setChg({ ...chg, bankAccount: e.target.value })} /></Col>
                  <Col md={6}><Form.Control placeholder="IFSC" value={chg.bankIfsc ?? ''} onChange={(e) => setChg({ ...chg, bankIfsc: e.target.value })} /></Col>
                  {!business && <Col md={6}><Form.Control placeholder="PAN" value={chg.pan ?? ''} onChange={(e) => setChg({ ...chg, pan: e.target.value })} /></Col>}
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
                  <Form.Check id="a" checked={agree.a} onChange={(e) => setAgree({ ...agree, a: e.target.checked })} label={`I have read and accept the ${user.agreementName ?? 'agreement'} v${user.agreementVersionRequired}`} />
                  <Form.Check id="d" checked={agree.d} onChange={(e) => setAgree({ ...agree, d: e.target.checked })} label="I consent to the data processing in Section 12." />
                  {business && <Form.Check id="r" checked={agree.r} onChange={(e) => setAgree({ ...agree, r: e.target.checked })} label="I confirm clause 6A.5 (registration and compliance). Optional: without it the fixed fee of clause 6A.6 applies." />}
                  <Button type="submit" size="sm" className="mt-2" disabled={!agree.a || !agree.d}>Accept</Button>
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
