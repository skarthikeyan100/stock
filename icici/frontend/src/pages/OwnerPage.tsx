import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Container, Form, Modal, Row, Tab, Table, Tabs } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { apiFetch, apiPost, readError } from '../utils/api';

type Json = Record<string, any>;
const when = (t?: string | null) => (t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '–');
const STATUS_BG: Record<string, string> = { ACTIVE: 'success', INVITED: 'info', AGREEMENT_PENDING: 'warning', PAUSED: 'warning', PAUSED_INVOICE: 'warning', TERMINATED: 'secondary' };

async function getJson(url: string): Promise<any> {
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(await readError(r));
  return r.json();
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="d-flex gap-2 align-items-center">
      <Form.Control size="sm" readOnly value={link} onFocus={(e) => e.target.select()} />
      <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the field is selectable */ } }}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

function ContractorsTab() {
  const [summary, setSummary] = useState<Json | null>(null);
  const [contractors, setContractors] = useState<Json[]>([]);
  const [invites, setInvites] = useState<Json[]>([]);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState<Json | null>(null);
  const [form, setForm] = useState({ type: 'INDIVIDUAL', email: '', send: false });
  const [reveal, setReveal] = useState<Json | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, c, i] = await Promise.all([getJson('/owner/summary'), getJson('/owner/contractors'), getJson('/owner/invites')]);
      setSummary(s); setContractors(c); setInvites(i); setErr('');
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (url: string, body: Json = {}) => {
    const r = await apiPost(url, body);
    if (!r.ok) { setErr(await readError(r)); return null; }
    setErr(''); const d = await r.json().catch(() => ({})); load(); return d;
  };
  const createInvite = async (e: FormEvent) => {
    e.preventDefault();
    const d = await act('/owner/invites', { type: form.type, email: form.email || undefined, send: form.send });
    if (d) { setCreated(d); setForm({ ...form, email: '' }); }
  };
  const showKyc = async (c: Json) => {
    if (!window.confirm(`Show the full PAN / GSTIN / bank account of ${c.name}? This is logged.`)) return;
    try { setReveal({ name: c.name, ...(await getJson(`/owner/contractors/${c.id}/kyc`)) }); } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      {err && <Alert variant="danger" onClose={() => setErr('')} dismissible>{err}</Alert>}
      <Row className="g-3 mb-3">
        <Col lg={5}>
          <Card>
            <Card.Header>New invitation {summary && <Badge bg="secondary" className="ms-2">active {summary.activeCount} / {summary.maxActive}</Badge>}</Card.Header>
            <Card.Body>
              <Form onSubmit={createInvite}>
                <Form.Select className="mb-2" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  <option value="INDIVIDUAL">Beginner: Individual (PAN), forecasts</option>
                  <option value="BUSINESS">Advanced: Business (GSTIN), recommendations</option>
                </Form.Select>
                <Form.Control className="mb-2" type="email" placeholder="Email (optional: locks the link to it; needed to send by Gmail)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                <Form.Check className="mb-2" id="send" label="Send it by Gmail" checked={form.send} onChange={(e) => setForm({ ...form, send: e.target.checked })} />
                <Button type="submit">Create invitation</Button>
              </Form>
              {created && (
                <Alert variant="success" className="mt-3 mb-0">
                  <div className="small mb-1">Single-use link (valid 7 days). It is shown once: copy it now and paste it into WhatsApp.</div>
                  <CopyLink link={created.link} />
                  {created.email && <div className="small mt-2">{created.email.error ? `Email failed: ${created.email.error}` : `Email sent${created.email.redirectedTo ? ` (test mode: delivered to ${created.email.redirectedTo})` : ''}.`}</div>}
                </Alert>
              )}
            </Card.Body>
          </Card>
        </Col>
        <Col lg={7}>
          <Card>
            <Card.Header>Invitations</Card.Header>
            <Card.Body className="p-0" style={{ maxHeight: 260, overflow: 'auto' }}>
              <Table size="sm" className="mb-0">
                <thead><tr><th>Created</th><th>Type</th><th>Email</th><th>State</th><th /></tr></thead>
                <tbody>
                  {invites.length === 0 && <tr><td colSpan={5} className="text-muted p-3">None.</td></tr>}
                  {invites.map((i) => {
                    const state = i.usedAt ? 'used' : i.revokedAt ? 'revoked' : new Date(i.expiresAt) < new Date() ? 'expired' : 'open';
                    return (
                      <tr key={i.id}>
                        <td>{when(i.createdAt)}</td><td>{i.type === 'BUSINESS' ? 'Advanced' : 'Beginner'}{i.targetContractorId ? ' (re-invite)' : ''}</td><td>{i.emailLock ?? '–'}</td>
                        <td><Badge bg={state === 'open' ? 'primary' : 'secondary'}>{state}</Badge></td>
                        <td className="text-end">{state === 'open' && <Button size="sm" variant="outline-danger" onClick={() => act(`/owner/invites/${i.id}/revoke`)}>Revoke</Button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <Card>
        <Card.Header>Contractors</Card.Header>
        <Card.Body className="p-0">
          <Table size="sm" responsive className="mb-0 align-middle">
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Agreement</th><th>SEBI</th><th>Slot</th><th /></tr></thead>
            <tbody>
              {contractors.length === 0 && <tr><td colSpan={7} className="text-muted p-3">No contractors yet.</td></tr>}
              {contractors.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}{c.isTest && <Badge bg="warning" text="dark" className="ms-1">TEST</Badge>}<div className="small text-muted">{c.email}</div></td>
                  <td>{c.type === 'BUSINESS' ? 'Advanced' : 'Beginner'}</td>
                  <td><Badge bg={STATUS_BG[c.status] ?? 'secondary'}>{c.status}</Badge>{c.statusReason && <div className="small text-muted">{c.statusReason}</div>}</td>
                  <td>{c.agreementVersion ? `v${c.agreementVersion}` : '–'}</td>
                  <td>{c.type === 'BUSINESS' ? (c.sebi ? <>{c.sebi.number}<div className="small">until {c.sebi.validUntil} {c.sebi.verified ? <Badge bg="success">verified</Badge> : <Button size="sm" variant="outline-success" onClick={() => act(`/owner/contractors/${c.id}/sebi-verify`, { verified: true })}>Verify</Button>}</div></> : '–') : ''}</td>
                  <td>{c.pseudoUserId || '–'}</td>
                  <td className="text-end text-nowrap">
                    {['INVITED', 'AGREEMENT_PENDING', 'PAUSED', 'PAUSED_INVOICE'].includes(c.status) && <Button size="sm" className="me-1" variant="success" onClick={() => act(`/owner/contractors/${c.id}/activate`)}>Activate</Button>}
                    {c.status === 'ACTIVE' && <Button size="sm" className="me-1" variant="outline-warning" onClick={() => { const reason = window.prompt('Reason for pausing?'); if (reason) act(`/owner/contractors/${c.id}/pause`, { reason }); }}>Pause</Button>}
                    {c.status !== 'TERMINATED' && <Button size="sm" className="me-1" variant="outline-primary" onClick={async () => { const d = await act(`/owner/contractors/${c.id}/reinvite`, { send: false }); if (d) setCreated({ ...d, email: null }); }}>Re-invite</Button>}
                    {c.status !== 'TERMINATED' && <Button size="sm" className="me-1" variant="outline-secondary" onClick={() => { if (window.confirm(`Sign ${c.name} out everywhere? They will need a new invitation.`)) act(`/owner/contractors/${c.id}/revoke-sessions`); }}>Revoke sessions</Button>}
                    {c.kycMasked && <Button size="sm" className="me-1" variant="outline-dark" onClick={() => showKyc(c)}>KYC</Button>}
                    {c.status !== 'TERMINATED' && <Button size="sm" variant="outline-danger" onClick={() => { if (window.confirm(`Terminate ${c.name}?`)) act(`/owner/contractors/${c.id}/terminate`, {}); }}>Terminate</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      <Modal show={!!reveal} onHide={() => setReveal(null)}>
        <Modal.Header closeButton><Modal.Title className="h6">KYC: {reveal?.name}</Modal.Title></Modal.Header>
        <Modal.Body>
          {reveal && <Table size="sm"><tbody>{Object.entries(reveal).filter(([k]) => k !== 'name').map(([k, v]) => <tr key={k}><td className="text-muted">{k}</td><td>{String(v)}</td></tr>)}</tbody></Table>}
        </Modal.Body>
      </Modal>
    </>
  );
}

function RecommendationsTab() {
  const [rows, setRows] = useState<Json[]>([]);
  useEffect(() => { getJson('/owner/recommendations').then(setRows).catch(() => undefined); }, []);
  return (
    <Table size="sm" responsive>
      <thead><tr><th>When</th><th>Contractor</th><th>Contract</th><th className="text-end">Entry</th><th className="text-end">Target</th><th className="text-end">Stop</th><th>Status</th><th>Decided</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={8} className="text-muted">None yet.</td></tr>}
        {rows.map((r) => <tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.contractorName}</td><td>{r.index} {r.contract}</td><td className="text-end">{r.entry}</td><td className="text-end">{r.target}</td><td className="text-end">{r.stop}</td><td><Badge bg={r.status === 'APPROVED' ? 'success' : r.status === 'PENDING' ? 'warning' : 'secondary'}>{r.status}</Badge></td><td>{when(r.decidedAt)} {r.note}</td></tr>)}
      </tbody>
    </Table>
  );
}

function KycChangesTab() {
  const [rows, setRows] = useState<Json[]>([]);
  const [err, setErr] = useState('');
  const load = useCallback(() => getJson('/owner/kyc-changes').then(setRows).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const decide = async (id: string, decision: 'approve' | 'reject') => {
    const r = await apiPost(`/owner/kyc-changes/${id}/decision`, { decision });
    if (!r.ok) setErr(await readError(r)); else { setErr(''); load(); }
  };
  return (
    <>
      {err && <Alert variant="danger">{err}</Alert>}
      <Table size="sm" responsive>
        <thead><tr><th>When</th><th>Contractor</th><th>Wants to change</th><th /></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} className="text-muted">No pending changes.</td></tr>}
          {rows.map((r) => <tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.name}<div className="small text-muted">{r.email}</div></td><td>{(r.fields as string[]).map((f) => f.replace(/Enc$/, '')).join(', ')}</td>
            <td className="text-end"><Button size="sm" variant="success" className="me-1" onClick={() => decide(r.id, 'approve')}>Approve</Button><Button size="sm" variant="outline-danger" onClick={() => decide(r.id, 'reject')}>Reject</Button></td></tr>)}
        </tbody>
      </Table>
    </>
  );
}

function AgreementsTab() {
  const [info, setInfo] = useState<Json | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = useCallback(() => getJson('/owner/agreements').then(setInfo).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const upload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr(''); setOk('');
    const fd = new FormData(e.currentTarget);
    const r = await apiFetch('/owner/agreements', { method: 'POST', body: fd });
    if (!r.ok) { setErr(await readError(r)); return; }
    setOk('Scheduled. Contractors move to "agreement pending" on the effective date, with a notice from 15 days before.'); load(); (e.target as HTMLFormElement).reset();
  };
  return (
    <>
      {info && <p>In force: <strong>v{info.current}</strong>{info.upcoming && <> · upcoming: v{info.upcoming.version} on {info.upcoming.effectiveDate}</>}</p>}
      <Table size="sm" className="mb-3" style={{ maxWidth: 520 }}>
        <thead><tr><th>Version</th><th>Effective</th><th>Recorded by</th></tr></thead>
        <tbody>{(info?.versions ?? []).map((v: Json) => <tr key={v.version}><td>v{v.version}</td><td>{v.effectiveDate}</td><td>{v.createdBy}</td></tr>)}{(info?.versions ?? []).length === 0 && <tr><td colSpan={3} className="text-muted">Only the built-in v{info?.current} (no scheduled versions).</td></tr>}</tbody>
      </Table>
      <Card style={{ maxWidth: 520 }}>
        <Card.Header>Upload a new agreement version</Card.Header>
        <Card.Body>
          <Form onSubmit={upload}>
            <Form.Control name="version" className="mb-2" placeholder="Version, e.g. 1.2" required />
            <Form.Control name="effectiveDate" className="mb-2" type="date" required />
            <Form.Label className="small mb-0">Individual (PAN) PDF</Form.Label><Form.Control name="individual" className="mb-2" type="file" accept="application/pdf" required />
            <Form.Label className="small mb-0">Business (GSTIN) PDF</Form.Label><Form.Control name="business" className="mb-2" type="file" accept="application/pdf" required />
            <Button type="submit">Upload and schedule</Button>
          </Form>
          {err && <div className="text-danger small mt-2">{err}</div>}{ok && <div className="text-success small mt-2">{ok}</div>}
        </Card.Body>
      </Card>
    </>
  );
}

export default function OwnerPage() {
  return (
    <Container fluid className="py-3 px-4">
      <div className="d-flex align-items-center gap-3 mb-3">
        <h1 className="h4 mb-0">Contractors</h1>
        <Link to="/trade">Trading</Link>
        <Link to="/admin">Admin</Link>
      </div>
      <Tabs defaultActiveKey="contractors" className="mb-3" mountOnEnter>
        <Tab eventKey="contractors" title="Contractors"><ContractorsTab /></Tab>
        <Tab eventKey="recs" title="Recommendations"><RecommendationsTab /></Tab>
        <Tab eventKey="kyc" title="KYC changes"><KycChangesTab /></Tab>
        <Tab eventKey="agreements" title="Agreements"><AgreementsTab /></Tab>
      </Tabs>
    </Container>
  );
}
