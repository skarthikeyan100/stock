import { FormEvent, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Container, Form, Row } from 'react-bootstrap';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiFetch, apiPost, readError } from '../utils/api';

interface InviteInfo {
  state: 'ok' | 'used' | 'revoked' | 'expired' | 'unknown';
  type?: 'INDIVIDUAL' | 'BUSINESS';
  emailLock?: string | null;
  reinvite?: { email: string; name: string; needsAgreement: boolean } | null;
  agreement?: { version: string; sha256: string; filename: string };
}
const GONE: Record<string, string> = { used: 'This invitation link has already been used.', revoked: 'This invitation link is no longer valid.', expired: 'This invitation link has expired.', unknown: 'This invitation link is not valid.' };

// Defined outside JoinPage: a component created inside it would be a new type on every render and lose focus on each keystroke.
function Field({ f, set, k, label, ...rest }: { f: Record<string, string>; set: (k: string) => (e: React.ChangeEvent<any>) => void; k: string; label: string } & Record<string, any>) {
  return <Col md={6}><Form.Label className="small mb-0">{label}</Form.Label><Form.Control value={f[k] ?? ''} onChange={set(k)} required={rest.required !== false} {...rest} /></Col>;
}

// /join/:token: the single-use invitation link. Read the agreement, give your details, accept: that creates your record and signs this browser in.
export default function JoinPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [f, setF] = useState<Record<string, string>>({});
  const [chk, setChk] = useState({ accept: false, dpdp: false, rep: false, notGst: false });
  const set = (k: string) => (e: React.ChangeEvent<any>) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    apiFetch(`/invite/${encodeURIComponent(token)}`).then(async (r) => {
      if (!r.ok) { setLoadErr(await readError(r)); return; }
      const d: InviteInfo = await r.json();
      setInfo(d);
      if (d.emailLock) setF((x) => ({ ...x, email: d.emailLock as string }));
    }).catch(() => setLoadErr('Could not reach the server. Try again in a moment.'));
  }, [token]);

  if (loadErr) return <Container className="py-5"><Alert variant="danger">{loadErr}</Alert></Container>;
  if (!info) return <Container className="py-5 text-muted">Loading…</Container>;
  if (info.state !== 'ok') return <Container className="py-5" style={{ maxWidth: 560 }}><Alert variant="secondary">{GONE[info.state]} If you need access, ask for a new invitation.</Alert></Container>;

  const business = info.type === 'BUSINESS';
  const version = info.agreement?.version ?? '';
  const re = info.reinvite;
  const needsAgreement = re ? re.needsAgreement : true;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const body = re
        ? { acceptTerms: chk.accept, dpdpConsent: chk.dpdp, representation6A5: chk.rep }
        : { email: f.email, name: f.name, acceptTerms: chk.accept, dpdpConsent: chk.dpdp, representation6A5: chk.rep,
            kyc: business
              ? { entityName: f.entityName, address: f.address, pan: f.pan, gstin: f.gstin, signatoryName: f.signatoryName, signatoryDesignation: f.signatoryDesignation, designatedForecasterName: f.name,
                  bankHolder: f.bankHolder, bankAccount: f.bankAccount, bankIfsc: f.bankIfsc, sebiNumber: f.sebiNumber || undefined, sebiValidUntil: f.sebiValidUntil || undefined }
              : { legalName: f.name, address: f.address, pan: f.pan, bankHolder: f.bankHolder, bankAccount: f.bankAccount, bankIfsc: f.bankIfsc, notGstRegistered: chk.notGst } };
      const res = await apiPost(`/invite/${encodeURIComponent(token)}/accept`, body);
      if (!res.ok) { setErr(await readError(res)); return; }
      await refreshUser();
      navigate('/my', { replace: true });
    } finally { setBusy(false); }
  };

  return (
    <Container className="py-4" style={{ maxWidth: 900 }}>
      <h1 className="h4 mb-1">Nivedha Tech – Forecasting programme</h1>
      <p className="text-muted">{re ? `Welcome back, ${re.name}.` : `You are invited as a ${business ? 'Business (GSTIN)' : 'Individual (PAN)'} contractor.`} This link works once and signs this browser in.</p>
      <Alert variant="warning" className="small">There is no login page. If you log out or clear your browser data you will need a new invitation, so keep using this browser.</Alert>
      <Form onSubmit={submit}>
        {needsAgreement && (
          <Card className="mb-3">
            <Card.Header>Forecasting Services Agreement v{version} · <a href={`/invite/${encodeURIComponent(token)}/agreement`} target="_blank" rel="noreferrer">open in a new tab</a></Card.Header>
            <Card.Body className="p-0"><iframe title="Agreement" src={`/invite/${encodeURIComponent(token)}/agreement`} style={{ width: '100%', height: 460, border: 0 }} /></Card.Body>
          </Card>
        )}
        {!re && (
          <Card className="mb-3">
            <Card.Header>Your details</Card.Header>
            <Card.Body>
              <Row className="g-2">
                <Field f={f} set={set} k="name" label={business ? 'Designated Forecaster name' : 'Full legal name'} />
                <Field f={f} set={set} k="email" label={business ? 'Designated Forecaster email' : 'Email'} type="email" readOnly={!!info.emailLock} />
                {business && <Field f={f} set={set} k="entityName" label="Legal entity name" />}
                <Field f={f} set={set} k="address" label={business ? 'Registered address' : 'Address'} />
                <Field f={f} set={set} k="pan" label={business ? 'Entity PAN' : 'PAN'} maxLength={10} style={{ textTransform: 'uppercase' }} />
                {business && <Field f={f} set={set} k="gstin" label="GSTIN (its PAN must match)" maxLength={15} style={{ textTransform: 'uppercase' }} />}
                {business && <Field f={f} set={set} k="signatoryName" label="Authorised signatory name" />}
                {business && <Field f={f} set={set} k="signatoryDesignation" label="Signatory designation" />}
                {business && <Field f={f} set={set} k="sebiNumber" label="SEBI Registration No. (Research Analyst, INH + 9 digits)" required={false} maxLength={12} style={{ textTransform: 'uppercase' }} />}
                {business && <Field f={f} set={set} k="sebiValidUntil" label="Registration valid until" type="date" required={false} />}
                <Field f={f} set={set} k="bankHolder" label="Bank account holder name" />
                <Field f={f} set={set} k="bankAccount" label="Bank account number" inputMode="numeric" />
                <Field f={f} set={set} k="bankIfsc" label="IFSC" maxLength={11} style={{ textTransform: 'uppercase' }} />
              </Row>
              {!business && <Form.Check className="mt-3" id="gst" checked={chk.notGst} onChange={(e) => setChk({ ...chk, notGst: e.target.checked })} label="I am not registered under GST." />}
            </Card.Body>
          </Card>
        )}
        {needsAgreement && (
          <Card className="mb-3"><Card.Body>
            <Form.Check id="acc" className="mb-2" checked={chk.accept} onChange={(e) => setChk({ ...chk, accept: e.target.checked })} label={`I have read and accept the Forecasting Services Agreement v${version}`} />
            <Form.Check id="dp" className="mb-2" checked={chk.dpdp} onChange={(e) => setChk({ ...chk, dpdp: e.target.checked })} label="I consent to the processing of my personal data as described in Section 12 of the agreement (DPDP Act, 2023)." />
            {business && <Form.Check id="rep" checked={chk.rep} onChange={(e) => setChk({ ...chk, rep: e.target.checked })} label="I confirm clause 6A.5: our SEBI registration is valid, and our compliance function has confirmed that receiving the Profit Share under this agreement is permitted for us." />}
          </Card.Body></Card>
        )}
        {err && <Alert variant="danger">{err}</Alert>}
        <Button type="submit" disabled={busy || (needsAgreement && (!chk.accept || !chk.dpdp || (business && !chk.rep)))}>{busy ? 'Please wait…' : re && !needsAgreement ? 'Continue' : 'Accept and continue'}</Button>
      </Form>
    </Container>
  );
}
