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
                  <option value="INDIVIDUAL">Researcher: Individual (PAN), forecasts</option>
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
        <Card.Header>Participants</Card.Header>
        <Card.Body className="p-0">
          <Table size="sm" responsive className="mb-0 align-middle">
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Agreement</th><th>SEBI</th><th>Trades as</th><th /></tr></thead>
            <tbody>
              {contractors.length === 0 && <tr><td colSpan={7} className="text-muted p-3">No participants yet.</td></tr>}
              {contractors.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}{c.isTest && <Badge bg="warning" text="dark" className="ms-1">TEST</Badge>}<div className="small text-muted">{c.email}</div></td>
                  <td>{c.type === 'BUSINESS' ? 'Advanced' : 'Beginner'}</td>
                  <td><Badge bg={STATUS_BG[c.status] ?? 'secondary'}>{c.status}</Badge>{c.statusReason && <div className="small text-muted">{c.statusReason}</div>}</td>
                  <td>{c.agreementVersion ? `v${c.agreementVersion}` : '–'}</td>
                  <td>{c.type === 'BUSINESS' ? (c.sebi ? <>{c.sebi.number}<div className="small">until {c.sebi.validUntil} {c.sebi.verified ? <Badge bg="success">verified</Badge> : <Button size="sm" variant="outline-success" onClick={() => act(`/owner/contractors/${c.id}/sebi-verify`, { verified: true })}>Verify</Button>}</div></> : '–') : ''}</td>
                  <td>{c.tradeUser || c.email}</td>
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
      <thead><tr><th>When</th><th>Research Analyst</th><th>Contract</th><th className="text-end">Entry</th><th className="text-end">Target</th><th className="text-end">Stop</th><th>Status</th><th>Decided</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={8} className="text-muted">None yet.</td></tr>}
        {rows.map((r) => <tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.contractorName}</td><td>{r.index} {r.contract}</td><td className="text-end">{r.entry}</td><td className="text-end">{r.target}</td><td className="text-end">{r.stop}</td><td><Badge bg={r.status === 'APPROVED' ? 'success' : r.status === 'PENDING' ? 'warning' : 'secondary'}>{r.status}</Badge></td><td>{when(r.decidedAt)} {r.note}</td></tr>)}
      </tbody>
    </Table>
  );
}

function PilotTab() {
  const [eng, setEng] = useState<Json | null>(null);
  const [data, setData] = useState<Json | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () => Promise.all([getJson('/owner/engine'), getJson('/owner/forecasts')]).then(([e, d]) => { setEng(e); setData(d); setErr(''); }).catch((e) => setErr(e.message));
    load(); const t = setInterval(load, 15000); return () => clearInterval(t);
  }, []);
  return (
    <>
      {err && <Alert variant="danger">{err}</Alert>}
      {eng && (
        <div className="d-flex gap-2 flex-wrap mb-3">
          <Badge bg={eng.ready ? 'success' : 'danger'}>engine {eng.ready ? 'running' : eng.startFailure ? 'refused to start' : 'starting'}</Badge>
          <Badge bg={eng.ordersEnabled ? 'warning' : 'secondary'} text={eng.ordersEnabled ? 'dark' : undefined}>orders {eng.ordersEnabled ? 'ON' : 'OFF (decisions only)'}</Badge>
          <Badge bg={eng.niftyAgeMs != null && eng.niftyAgeMs < 10000 ? 'success' : 'danger'}>NIFTY feed {eng.niftyAgeMs == null ? 'none' : `${Math.round(eng.niftyAgeMs / 1000)}s old`}</Badge>
          {eng.passThroughAlarm.rejectionRate != null && <Badge bg={eng.passThroughAlarm.firing ? 'danger' : 'secondary'}>rejection rate {Math.round(eng.passThroughAlarm.rejectionRate * 100)}% (last 30)</Badge>}
        </div>
      )}
      {eng?.startFailure && <Alert variant="danger">{eng.startFailure}</Alert>}
      {eng?.passThroughAlarm.firing && <Alert variant="danger">Pass-through alarm: your filters are rejecting too few forecasts. Review the thresholds in config.yml (they are never lowered automatically).</Alert>}
      {data && (
        <>
          <h6>{data.day}</h6>
          <Table size="sm" responsive>
            <thead><tr><th>Researcher</th><th className="text-end">Forecasts</th><th className="text-end">Passed filters</th><th className="text-end">Rejected</th><th className="text-end">Orders armed</th><th className="text-end">Accuracy (scored)</th></tr></thead>
            <tbody>
              {data.per.length === 0 && <tr><td colSpan={6} className="text-muted">No Researchers yet.</td></tr>}
              {data.per.map((p: Json) => <tr key={p.contractorId}><td>{p.name}</td><td className="text-end">{p.forecasts}</td><td className="text-end">{p.accepted}</td><td className="text-end">{p.rejected}</td><td className="text-end">{p.ordersPlaced}</td><td className="text-end">{p.accuracy.accuracyPct == null ? '–' : `${p.accuracy.accuracyPct}% of ${p.accuracy.scored}`}</td></tr>)}
            </tbody>
          </Table>
          <Table size="sm" responsive>
            <thead><tr><th>Time</th><th>Participant</th><th>Call</th><th>Decision</th><th>Why</th><th>Order</th><th>Outcome</th></tr></thead>
            <tbody>
              {data.recent.map((r: Json) => (
                <tr key={r.id}>
                  <td>{when(r.submittedAt)}</td><td>{r.contractor}</td><td>{r.direction}</td>
                  <td>{r.decision ? <Badge bg={r.decision.accepted ? 'success' : 'secondary'}>{r.decision.accepted ? 'passed' : 'rejected'}</Badge> : '…'}</td>
                  <td className="small">{r.decision?.filters?.map((f: Json) => <div key={f.name}>{f.pass ? '✓' : '✗'} {f.name}: {f.reason}</div>)}</td>
                  <td className="small">{r.decision ? (r.decision.orderPlaced ? 'armed' : r.decision.orderNote) : ''}</td>
                  <td><Badge bg={r.outcome === 'CORRECT' ? 'success' : r.outcome === 'INCORRECT' ? 'danger' : 'secondary'}>{r.outcome.toLowerCase()}</Badge></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </>
  );
}

function FeesTab() {
  const [data, setData] = useState<Json | null>(null);
  const [contractors, setContractors] = useState<Json[]>([]);
  const [err, setErr] = useState('');
  const [fm, setFm] = useState({ contractor: '', from: '', model: 'PROFIT_SHARE', value: '', months: '1', ref: '' });
  const load = useCallback(() => Promise.all([getJson('/owner/statements'), getJson('/owner/contractors')]).then(([d, c]) => { setData(d); setContractors(c); setErr(''); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const post = async (url: string, body: Json = {}) => { const r = await apiPost(url, body); if (!r.ok) { setErr(await readError(r)); return null; } setErr(''); load(); return r.json().catch(() => ({})); };
  const advanced = contractors.filter((c) => c.type === 'BUSINESS' && c.status !== 'TERMINATED');
  const saveModel = async (e: FormEvent) => {
    e.preventDefault();
    await post(`/owner/contractors/${fm.contractor}/fee-model`, { from: fm.from, model: fm.model, ...(fm.model === 'PROFIT_SHARE' ? { sharePercent: Number(fm.value) } : { fixedAmount: Number(fm.value), durationMonths: Number(fm.months || 1), ...(fm.ref ? { referenceInvestment: Number(fm.ref) } : {}) }) });
  };
  return (
    <>
      {err && <Alert variant="danger" onClose={() => setErr('')} dismissible>{err}</Alert>}
      {data && !data.taxPhaseComplete && <Alert variant="warning">Payments are locked for real participants until the tax phase is complete (<code>forecast.taxPhaseComplete</code> in config.yml). Statements are created and can be reviewed; Approve and Mark paid are refused. The TEST user is not affected.</Alert>}
      <div className="d-flex gap-2 mb-3 flex-wrap">
        <Button size="sm" variant="outline-primary" onClick={() => post('/owner/statements/run', { kind: 'weekly' })}>Run weekly statements now</Button>
        <Button size="sm" variant="outline-primary" onClick={() => post('/owner/statements/run', { kind: 'monthly' })}>Run monthly retainers now</Button>
        <span className="small text-muted align-self-center">They also run by themselves: weekly on Wednesday from 06:00 IST, retainers on the 1st. Running again creates nothing twice.</span>
      </div>
      <Table size="sm" responsive className="align-middle">
        <thead><tr><th>Participant</th><th>Kind</th><th>Period</th><th className="text-end">Gross (₹)</th><th>Details</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(data?.statements ?? []).length === 0 && <tr><td colSpan={7} className="text-muted">No statements yet.</td></tr>}
          {(data?.statements ?? []).map((s: Json) => (
            <tr key={s.id}>
              <td>{s.contractor}{s.isTest && <Badge bg="warning" text="dark" className="ms-1">TEST</Badge>}</td>
              <td className="small">{s.kind.replace(/_/g, ' ').toLowerCase()}</td>
              <td>{s.periodFrom} to {s.periodTo}</td>
              <td className="text-end">{s.gross.toLocaleString('en-IN')}</td>
              <td className="small">{Object.entries(s.lines).map(([k, v]) => `${k}: ${v}`).join(' · ')}{s.invoice ? ` · invoice ${s.invoice.number}` : s.invoiceDueAt ? ` · invoice due ${when(s.invoiceDueAt)}` : ''}</td>
              <td><Badge bg={s.status === 'PAID' ? 'success' : s.status === 'APPROVED' ? 'info' : 'secondary'}>{s.status}</Badge>{s.utr && <div className="small">UTR {s.utr}</div>}</td>
              <td className="text-end text-nowrap">
                {s.status === 'DRAFT' && <Button size="sm" variant="outline-success" onClick={() => post(`/owner/statements/${s.id}/approve`)}>Approve</Button>}
                {s.status === 'APPROVED' && <Button size="sm" variant="success" onClick={() => { const utr = window.prompt('UTR reference of the payment?'); if (utr) post(`/owner/statements/${s.id}/paid`, { utr }); }}>Mark paid</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Card style={{ maxWidth: 640 }}>
        <Card.Header>Advanced fee model (effective-dated; never applies to an earlier period)</Card.Header>
        <Card.Body>
          <Form onSubmit={saveModel}>
            <Row className="g-2">
              <Col md={6}><Form.Select value={fm.contractor} onChange={(e) => setFm({ ...fm, contractor: e.target.value })} required><option value="">Research Analyst…</option>{advanced.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Form.Select></Col>
              <Col md={6}><Form.Control type="date" value={fm.from} onChange={(e) => setFm({ ...fm, from: e.target.value })} required /></Col>
              <Col md={6}><Form.Select value={fm.model} onChange={(e) => setFm({ ...fm, model: e.target.value })}><option value="PROFIT_SHARE">Profit share (%)</option><option value="FIXED_PERIOD">Fixed fee for a duration (₹ per period)</option></Form.Select></Col>
              <Col md={6}><Form.Control inputMode="decimal" placeholder={fm.model === 'PROFIT_SHARE' ? 'Percent, e.g. 25' : 'Rupees per period, e.g. 25000'} value={fm.value} onChange={(e) => setFm({ ...fm, value: e.target.value })} required /></Col>
              {fm.model === 'FIXED_PERIOD' && <>
                <Col md={6}><Form.Control inputMode="numeric" placeholder="Duration in months (default 1)" value={fm.months} onChange={(e) => setFm({ ...fm, months: e.target.value })} /></Col>
                <Col md={6}><Form.Control inputMode="decimal" placeholder="Reference investment ₹ (default ₹1,00,000)" value={fm.ref} onChange={(e) => setFm({ ...fm, ref: e.target.value })} /></Col>
              </>}
            </Row>
            <Button type="submit" size="sm" className="mt-2">Set from that date</Button>
          </Form>
        </Card.Body>
      </Card>
    </>
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
        <thead><tr><th>When</th><th>Participant</th><th>Wants to change</th><th /></tr></thead>
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
    setOk('Scheduled. Participants move to "agreement pending" on the effective date, with a notice from 15 days before.'); load(); (e.target as HTMLFormElement).reset();
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
        <h1 className="h4 mb-0">Participants</h1>
        <Link to="/trade">Trading</Link>
        <Link to="/admin">Admin</Link>
      </div>
      <Tabs defaultActiveKey="contractors" className="mb-3" mountOnEnter>
        <Tab eventKey="contractors" title="Participants"><ContractorsTab /></Tab>
        <Tab eventKey="recs" title="Recommendations"><RecommendationsTab /></Tab>
        <Tab eventKey="pilot" title="Pilot (forecasts)"><PilotTab /></Tab>
        <Tab eventKey="fees" title="Fees"><FeesTab /></Tab>
        <Tab eventKey="kyc" title="KYC changes"><KycChangesTab /></Tab>
        <Tab eventKey="agreements" title="Agreements"><AgreementsTab /></Tab>
      </Tabs>
    </Container>
  );
}
