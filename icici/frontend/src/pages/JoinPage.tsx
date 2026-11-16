import { FormEvent, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Container, Form, Row, Table } from 'react-bootstrap';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiFetch, apiPost, readError } from '../utils/api';

interface InviteInfo {
  agreementName?: string;
  state: 'ok' | 'used' | 'revoked' | 'expired' | 'unknown';
  type?: 'INDIVIDUAL' | 'BUSINESS';
  emailLock?: string | null;
  reinvite?: { email: string; name: string; needsAgreement: boolean } | null;
  agreement?: { version: string; sha256: string; filename: string };
  // Advanced only: Schedules 1 (fee) and 2 (rules) as one table; a row with `section` is a heading
  schedule?: { title: string; rows: { section?: string; item?: string; value?: string }[] } | null;
}
const GONE: Record<string, string> = { used: 'This invitation link has already been used.', revoked: 'This invitation link is no longer valid.', expired: 'This invitation link has expired.', unknown: 'This invitation link is not valid.' };

// The SEBI registration's valid-until is prefilled one month from today (YYYY-MM-DD, the contractor can change it).
function oneMonthFromToday(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
  const [f, setF] = useState<Record<string, string>>(() => ({ sebiValidUntil: oneMonthFromToday() }));
  const [chk, setChk] = useState({ accept: false, dpdp: false, rep: false, notGst: false });
  const [pdfUrl, setPdfUrl] = useState<string | null>(null); // the agreement with the details typed so far, from the server
  const [previewing, setPreviewing] = useState(false);
  // Changing a detail invalidates the preview: what is accepted must be exactly what was shown.
  const set = (k: string) => (e: React.ChangeEvent<any>) => { setPdfUrl(null); setChk((c) => ({ ...c, accept: false, dpdp: false })); setF((x) => ({ ...x, [k]: e.target.value })); };

  useEffect(() => {
    apiFetch(`/invite/${encodeURIComponent(token)}`).then(async (r) => {
      if (!r.ok) { setLoadErr(await readError(r)); return; }
      const d: InviteInfo = await r.json();
      setInfo(d);
      if (d.emailLock) setF((x) => ({ ...x, email: d.emailLock as string }));
    }).catch(() => setLoadErr('Could not reach the server. Try again in a moment.'));
  }, [token]);

  const business = info?.type === 'BUSINESS';
  const version = info?.agreement?.version ?? '';
  const re = info?.reinvite;
  const needsAgreement = re ? re.needsAgreement : true;

  const kycBody = () => (business
    ? { entityName: f.entityName, gstin: f.gstin, analystName: f.name,
        bankHolder: f.bankHolder, bankAccount: f.bankAccount, bankIfsc: f.bankIfsc, sebiNumber: f.sebiNumber, sebiValidUntil: f.sebiValidUntil }
    : { legalName: f.name, address: f.address, pan: f.pan, bankHolder: f.bankHolder, bankAccount: f.bankAccount, bankIfsc: f.bankIfsc, notGstRegistered: chk.notGst });

  // Fetches the agreement with the details filled in (nothing is stored until Accept).
  const preview = async () => {
    setErr('');
    if (!re) {
      const missing = [business && !f.gstin && 'the GSTIN', business && !f.sebiNumber && 'the SEBI registration number', business && !f.sebiValidUntil && 'the registration valid-until date', !business && !f.pan && 'the PAN', !business && !chk.notGst && 'the "not registered under GST" tick'].filter(Boolean);
      if (missing.length) { setErr(`Please give ${missing.join(' and ')} first.`); return; }
    }
    setPreviewing(true);
    try {
      const res = await apiPost(`/invite/${encodeURIComponent(token)}/preview`, re ? { representation6A5: chk.rep } : { name: f.name, kyc: kycBody(), representation6A5: chk.rep });
      if (!res.ok) { setErr(await readError(res)); return; }
      setPdfUrl(URL.createObjectURL(await res.blob()));
    } finally { setPreviewing(false); }
  };
  useEffect(() => { if (re && re.needsAgreement) void preview(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [re?.needsAgreement]);

  // The agreement is prepared by itself as soon as the required details are in (and again, after a short pause, whenever a detail changes).
  const ready = !re && (business ? (f.gstin ?? '').trim().length === 15 && (f.sebiNumber ?? '').trim().length === 12 && !!f.sebiValidUntil : (f.pan ?? '').trim().length === 10 && chk.notGst);
  const detailsKey = JSON.stringify([f, chk.notGst, chk.rep]);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => { void preview(); }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsKey, ready]);

  if (loadErr) return <Container className="py-5"><Alert variant="danger">{loadErr}</Alert></Container>;
  if (!info) return <Container className="py-5 text-muted">Loading…</Container>;
  if (info.state !== 'ok') return <Container className="py-5" style={{ maxWidth: 560 }}><Alert variant="secondary">{GONE[info.state]} If you need access, ask for a new invitation.</Alert></Container>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const body = re
        ? { acceptTerms: chk.accept, dpdpConsent: chk.dpdp, representation6A5: chk.rep }
        : { email: f.email ?? '', name: f.name, acceptTerms: chk.accept, dpdpConsent: chk.dpdp, representation6A5: chk.rep, kyc: kycBody() };
      const res = await apiPost(`/invite/${encodeURIComponent(token)}/accept`, body);
      if (!res.ok) { setErr(await readError(res)); return; }
      await refreshUser();
      navigate('/my', { replace: true });
    } finally { setBusy(false); }
  };

  return (
    <Container className="py-4" style={{ maxWidth: 900 }}>
      <h1 className="h4 mb-1">Nivedha Tech – Forecasting programme</h1>
      <p className="text-muted">{re ? `Welcome back, ${re.name}.` : `You are invited as a ${business ? 'Business (GSTIN)' : 'Individual (PAN)'} contractor.`} This link works once and signs this browser in. Give your details first; the agreement is then prepared with them for you to read and accept.</p>
      <Alert variant="warning" className="small">There is no login page. If you log out or clear your browser data you will need a new invitation, so keep using this browser.</Alert>
      <Form onSubmit={submit}>
        {!re && (
          <Card className="mb-3">
            <Card.Header>Your details <span className="small text-muted ms-2">{business ? 'Your GSTIN and SEBI registration number are required' : 'Your email, the PAN and the GST declaration are required'}; everything else can be added later on your profile page.</span></Card.Header>
            <Card.Body>
              <Row className="g-2">
                <Field f={f} set={set} required={false} k="name" label={business ? 'Research Analyst name' : 'Full legal name'} />
                {(!business || !!info.emailLock) && <Field f={f} set={set} required={!business} k="email" label={business ? 'Research Analyst email' : 'Email'} type="email" readOnly={!!info.emailLock} />}
                {business && <Field f={f} set={set} required={false} k="entityName" label="Legal entity name" />}
                {!business && <Field f={f} set={set} required={false} k="address" label="Address" />}
                {!business && <Field f={f} set={set} k="pan" label="PAN" maxLength={10} style={{ textTransform: 'uppercase' }} />}
                {business && <Field f={f} set={set} k="gstin" label="GSTIN" maxLength={15} style={{ textTransform: 'uppercase' }} />}
                {business && <Field f={f} set={set} k="sebiNumber" label="SEBI Registration No. (Research Analyst, INH + 9 digits)" maxLength={12} style={{ textTransform: 'uppercase' }} />}
                {business && <Field f={f} set={set} k="sebiValidUntil" label="Registration valid until" type="date" />}
                <Field f={f} set={set} required={false} k="bankHolder" label="Bank account holder name" />
                <Field f={f} set={set} required={false} k="bankAccount" label="Bank account number" inputMode="numeric" />
                <Field f={f} set={set} required={false} k="bankIfsc" label="IFSC" maxLength={11} style={{ textTransform: 'uppercase' }} />
              </Row>
              {!business && <Form.Check className="mt-3" id="gst" checked={chk.notGst} onChange={(e) => setChk({ ...chk, notGst: e.target.checked })} label="I am not registered under GST." />}
            </Card.Body>
          </Card>
        )}
        {info.schedule && (
        <Card className="mb-3">
          <Card.Header>{info.schedule.title}</Card.Header>
          <Card.Body className="p-0">
            <Table size="sm" responsive className="mb-0">
              <tbody>
                {info.schedule.rows.map((r, i) => (r.section
                  ? <tr key={i} className="bg-body-tertiary"><th colSpan={2} className="small">{r.section}</th></tr>
                  : <tr key={i}><td className="small" style={{ width: '40%' }}>{r.item}</td><td className="small">{r.value}</td></tr>))}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
        )}
        {needsAgreement && !pdfUrl && !re && (
          <div className="mb-3 small text-muted">
            {previewing ? 'Preparing your agreement…' : business ? 'Enter your 15-character GSTIN and your SEBI registration number: your agreement is then prepared here with your details.' : 'Enter your PAN and tick the GST box: your agreement is then prepared here with your details.'}
            {err && <div className="text-danger mt-1">{err}</div>}
          </div>
        )}
        {needsAgreement && pdfUrl && (
          <Card className="mb-3">
            <Card.Header>{info.agreementName} v{version} · <a href={pdfUrl} target="_blank" rel="noreferrer">open in a new tab</a></Card.Header>
            <Card.Body className="p-0"><iframe title="Agreement" src={pdfUrl} style={{ width: '100%', height: 460, border: 0 }} /></Card.Body>
          </Card>
        )}
        {needsAgreement && pdfUrl && (
          <Card className="mb-3"><Card.Body>
            <Form.Check id="acc" className="mb-2" checked={chk.accept} onChange={(e) => setChk({ ...chk, accept: e.target.checked })} label={`I have read and accept the ${info.agreementName} v${version}`} />
            <Form.Check id="dp" className="mb-2" checked={chk.dpdp} onChange={(e) => setChk({ ...chk, dpdp: e.target.checked })} label="I consent to the processing of my personal data as described in Section 12 of the agreement (DPDP Act, 2023)." />
            {business && <>
              <Form.Check id="rep" checked={chk.rep} onChange={(e) => { setPdfUrl(null); setChk({ ...chk, rep: e.target.checked, accept: false, dpdp: false }); }} label="I confirm clause 6A.5: our SEBI registration is valid, and our compliance function has confirmed that receiving the Profit Share under this agreement is permitted for us." />
              <div className="small text-muted ms-4">Optional. If you do not tick this, the fixed fee per Fee Period in clause 6A.6 applies from the start instead of the Profit Share; the agreement above is prepared accordingly.</div>
            </>}
          </Card.Body></Card>
        )}
        {err && <Alert variant="danger">{err}</Alert>}
        {(!re && !business && !f.email || (needsAgreement && (!pdfUrl || !chk.accept || !chk.dpdp))) && <div className="small text-muted mb-2">To continue: {[!re && !business && !f.email && 'enter your email (at the top of the form)', !pdfUrl && 'the agreement must be prepared (it appears above once your details are in)', pdfUrl && !chk.accept && 'tick the agreement', pdfUrl && !chk.dpdp && 'tick the data consent'].filter(Boolean).join('; ')}.</div>}
        <Button type="submit" disabled={busy || (!re && !business && !f.email) || (needsAgreement && (!pdfUrl || !chk.accept || !chk.dpdp))}>{busy ? 'Please wait…' : re && !needsAgreement ? 'Continue' : 'Accept and continue'}</Button>
      </Form>
    </Container>
  );
}
