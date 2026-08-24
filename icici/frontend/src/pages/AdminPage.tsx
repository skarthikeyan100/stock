import { useState, useEffect, CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Table, Form, Button, Spinner, Tabs, Tab, Card, Row, Col, Alert } from 'react-bootstrap';
import { useAuth, AuthUser } from '../context/AuthContext';

interface UserRow extends AuthUser {
  sessionPnL: number;
  hasActiveTrade: boolean;
}

// Pins the Actions column to the right edge of the horizontally-scrollable
// users table so Save/Cancel stay reachable without scrolling, regardless of
// how many columns precede it.
const stickyActionsStyle: CSSProperties = {
  position: 'sticky',
  right: 0,
  background: '#fff',
  boxShadow: '-2px 0 4px rgba(0, 0, 0, 0.1)',
};

async function patchVerify(email: string, field: 'email' | 'phone' | 'address' | 'dob' | 'pan', verified: boolean) {
  await fetch(`/users/${encodeURIComponent(email)}/verify`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, verified }),
  });
}

export default function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Record<string, { lossLimit: string; lotCount: string; role: string; enabled: boolean; useGTT: boolean; profitSplitPercent: string; perOrderCap: string }>>({});
  const [config, setConfig] = useState<any>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState(false);
  const [indicatorsJsonError, setIndicatorsJsonError] = useState<string | null>(null);
  const [antConnecting, setAntConnecting] = useState(false);
  const [antResult, setAntResult] = useState<{ success: boolean; message: string } | null>(null);
  const [activeTab, setActiveTab] = useState('users');
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', name: '', lossLimit: '15000', lotCount: '10', role: 'user' });
  const [userError, setUserError] = useState<string | null>(null);

  // Payments tab
  const [payoutUser, setPayoutUser] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [computed, setComputed] = useState<any>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [payoutNote, setPayoutNote] = useState('');
  const [adminPayouts, setAdminPayouts] = useState<any[]>([]);
  const [payoutsFilter, setPayoutsFilter] = useState('');
  const [payoutsLoading, setPayoutsLoading] = useState(true);

  const fetchAdminPayouts = () => {
    setPayoutsLoading(true);
    const qs = payoutsFilter ? `?status=${encodeURIComponent(payoutsFilter)}` : '';
    fetch(`/admin/payouts${qs}`)
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setAdminPayouts(data); })
      .catch(() => {})
      .finally(() => setPayoutsLoading(false));
  };

  useEffect(() => {
    if (activeTab !== 'payments') return;
    fetchAdminPayouts();
  }, [activeTab, payoutsFilter]);

  const computePayout = async () => {
    setComputeError(null);
    setComputed(null);
    if (!payoutUser || !periodStart || !periodEnd) {
      setComputeError('Select a user and both dates');
      return;
    }
    setComputing(true);
    try {
      const res = await fetch('/admin/payouts/compute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: payoutUser, periodStart, periodEnd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to compute payout');
      setComputed(data);
    } catch (e: any) {
      setComputeError(e.message);
    } finally {
      setComputing(false);
    }
  };

  const createPayout = async () => {
    setComputeError(null);
    try {
      const res = await fetch('/admin/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: payoutUser, periodStart, periodEnd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create payout');
      setComputed(null);
      fetchAdminPayouts();
    } catch (e: any) {
      setComputeError(e.message);
    }
  };

  const decidePayout = async (id: string, status: 'paid' | 'rejected') => {
    setDecidingId(id);
    try {
      await fetch(`/admin/payouts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note: payoutNote }),
      });
      setPayoutNote('');
      fetchAdminPayouts();
    } finally {
      setDecidingId(null);
    }
  };

  const fetchUsers = () => {
    fetch('/users')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setUsers(data);
      })
      .catch(err => console.error('Failed to load users:', err))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchUsers();
    if (activeTab !== 'users') return;
    const interval = setInterval(fetchUsers, 5000);
    return () => clearInterval(interval);
  }, [activeTab]);

  const fetchConfig = () => {
    setConfigLoading(true);
    setConfigError(null);
    fetch('/config')
      .then(res => res.json())
      .then(data => setConfig(data))
      .catch(err => {
        console.error('Failed to load config:', err);
        setConfigError('Failed to load configuration');
      })
      .finally(() => setConfigLoading(false));
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const startEdit = (u: UserRow) => {
    setEditing(prev => ({
      ...prev,
      [u.email]: {
        lossLimit: String(u.lossLimit), lotCount: String(u.lotCount), role: u.role, enabled: u.enabled ?? true, useGTT: u.useGTT ?? true,
        profitSplitPercent: String(u.profitSplitPercent ?? 80), perOrderCap: u.perOrderCap !== undefined ? String(u.perOrderCap) : '',
      },
    }));
  };

  const cancelEdit = (email: string) => {
    setEditing(prev => {
      const next = { ...prev };
      delete next[email];
      return next;
    });
  };

  const saveEdit = async (email: string) => {
    const vals = editing[email];
    if (!vals) return;
    try {
      await fetch(`/users/${encodeURIComponent(email)}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lossLimit: Number(vals.lossLimit),
          lotCount: Number(vals.lotCount),
          enabled: vals.enabled,
          useGTT: vals.useGTT,
          profitSplitPercent: Number(vals.profitSplitPercent),
          perOrderCap: vals.perOrderCap === '' ? undefined : Number(vals.perOrderCap),
        }),
      });
      // Update role if changed
      const currentUser = users.find(u => u.email === email);
      if (currentUser && currentUser.role !== vals.role) {
        await fetch(`/users/${encodeURIComponent(email)}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: vals.role }),
        });
      }
      cancelEdit(email);
      fetchUsers();
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  const saveConfig = async () => {
    setConfigError(null);
    setConfigSuccess(false);
    try {
      const res = await fetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error('Failed to save config');
      setConfigSuccess(true);
      const t = setTimeout(() => setConfigSuccess(false), 3000);
      return () => clearTimeout(t);
    } catch (err) {
      console.error('Config save failed:', err);
      setConfigError('Failed to save configuration');
    }
  };

  const connectAnt = async () => {
    setAntConnecting(true);
    setAntResult(null);
    try {
      const res = await fetch('/ant/connect');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.details || data.error || 'Failed to connect');
      }
      setAntResult({ success: true, message: 'Connected to ANT streaming.' });
    } catch (err: any) {
      setAntResult({ success: false, message: err.message || 'Failed to connect to ANT streaming' });
    } finally {
      setAntConnecting(false);
    }
  };

  const updateConfigValue = (path: string[], value: any) => {
    setConfig((prev: any) => {
      const updated = JSON.parse(JSON.stringify(prev));
      let current = updated;
      for (let i = 0; i < path.length - 1; i++) {
        current = current[path[i]];
      }
      current[path[path.length - 1]] = value;
      return updated;
    });
  };

  const handleAddUser = async () => {
    setUserError(null);
    if (!newUser.email || !newUser.name) {
      setUserError('Email and name are required');
      return;
    }
    try {
      const res = await fetch('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newUser.email,
          name: newUser.name,
          lossLimit: Number(newUser.lossLimit),
          lotCount: Number(newUser.lotCount),
          role: newUser.role,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to create user');
      }
      setNewUser({ email: '', name: '', lossLimit: '15000', lotCount: '10', role: 'user' });
      setShowAddUser(false);
      fetchUsers();
    } catch (err: any) {
      setUserError(err.message);
    }
  };

  const handleDeleteUser = async (email: string) => {
    if (!confirm(`Are you sure you want to delete user ${email}?`)) return;
    try {
      const res = await fetch(`/users/${encodeURIComponent(email)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete user');
      fetchUsers();
    } catch (err) {
      console.error('Delete user error:', err);
      alert('Failed to delete user');
    }
  };

  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center min-vh-100">
        <Spinner animation="border" />
      </div>
    );
  }

  const renderConfigField = (label: string, path: string[], value: any, type: 'number' | 'boolean' | 'text' = 'number') => {
    if (type === 'boolean') {
      return (
        <Form.Check
          type="switch"
          label={label}
          checked={value}
          onChange={e => updateConfigValue(path, e.target.checked)}
        />
      );
    }
    return (
      <Form.Group className="mb-3">
        <Form.Label>{label}</Form.Label>
        <Form.Control
          type={type}
          value={value}
          onChange={e => updateConfigValue(path, type === 'number' ? Number(e.target.value) : e.target.value)}
        />
      </Form.Group>
    );
  };

  return (
    <div className="min-vh-100 bg-light">
      <div className="bg-dark bg-opacity-10 border-bottom">
        <Container className="py-2 d-flex justify-content-between align-items-center">
          <span className="fw-bold">Admin Dashboard</span>
          <div className="d-flex align-items-center gap-3">
            <Button variant="outline-secondary" size="sm" onClick={() => navigate('/app/trade')}>← Trading</Button>
            <span className="text-muted small">{user?.email}</span>
          </div>
        </Container>
      </div>

      <Container className="py-4">
        <Tabs activeKey={activeTab} onSelect={(k) => setActiveTab(k || 'users')} className="mb-3">
          <Tab eventKey="users" title="User Management">
            <div className="d-flex justify-content-between align-items-center mb-3">
              <h5 className="mb-0">Users</h5>
              <Button variant="primary" size="sm" onClick={() => setShowAddUser(!showAddUser)}>
                {showAddUser ? 'Cancel' : 'Add User'}
              </Button>
            </div>

            {showAddUser && (
              <Card className="mb-3">
                <Card.Body>
                  <h6>Create New User</h6>
                  {userError && <Alert variant="danger" dismissible onClose={() => setUserError(null)}>{userError}</Alert>}
                  <Row>
                    <Col md={6}>
                      <Form.Group className="mb-3">
                        <Form.Label>Email *</Form.Label>
                        <Form.Control
                          type="email"
                          placeholder="user@example.com"
                          value={newUser.email}
                          onChange={e => setNewUser(prev => ({ ...prev, email: e.target.value }))}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group className="mb-3">
                        <Form.Label>Name *</Form.Label>
                        <Form.Control
                          type="text"
                          placeholder="Full Name"
                          value={newUser.name}
                          onChange={e => setNewUser(prev => ({ ...prev, name: e.target.value }))}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={4}>
                      <Form.Group className="mb-3">
                        <Form.Label>Loss Limit (₹)</Form.Label>
                        <Form.Control
                          type="number"
                          value={newUser.lossLimit}
                          onChange={e => setNewUser(prev => ({ ...prev, lossLimit: e.target.value }))}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={4}>
                      <Form.Group className="mb-3">
                        <Form.Label>Lot Count</Form.Label>
                        <Form.Control
                          type="number"
                          value={newUser.lotCount}
                          onChange={e => setNewUser(prev => ({ ...prev, lotCount: e.target.value }))}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={4}>
                      <Form.Group className="mb-3">
                        <Form.Label>Role</Form.Label>
                        <Form.Select
                          value={newUser.role}
                          onChange={e => setNewUser(prev => ({ ...prev, role: e.target.value }))}
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                        </Form.Select>
                      </Form.Group>
                    </Col>
                  </Row>
                  <Button variant="success" onClick={handleAddUser}>Create User</Button>
                </Card.Body>
              </Card>
            )}

            <Table striped bordered hover responsive>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Loss Limit</th>
                  <th>Lot Count</th>
                  <th>Profit Split %</th>
                  <th>Per-Order Cap</th>
                  <th>Use GTT</th>
                  <th>Session P&amp;L</th>
                  <th>Active</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>KYC</th>
                  <th style={stickyActionsStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const isEditing = !!editing[u.email];
                  const pnlColor = u.sessionPnL >= 0 ? 'text-success' : 'text-danger';
                  return (
                    <tr key={u.email}>
                      <td>
                        <div className="d-flex align-items-center gap-2">
                          {u.picture && <img src={u.picture} alt="" width={28} height={28} className="rounded-circle" />}
                          <span>{u.name}</span>
                        </div>
                      </td>
                      <td>{u.email}</td>
                      <td>
                        {isEditing ? (
                          <Form.Select
                            size="sm"
                            value={editing[u.email].role}
                            onChange={e => setEditing(prev => ({
                              ...prev,
                              [u.email]: { ...prev[u.email], role: e.target.value },
                            }))}
                            style={{ width: 100 }}
                          >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                          </Form.Select>
                        ) : (
                          <span className={`badge ${u.role === 'admin' ? 'bg-danger' : 'bg-secondary'}`}>
                            {u.role}
                          </span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Check
                            type="switch"
                            id={`enabled-${u.email}`}
                            label={editing[u.email].enabled ? 'Enabled' : 'Disabled'}
                            checked={editing[u.email].enabled}
                            onChange={e => setEditing(prev => ({
                              ...prev,
                              [u.email]: { ...prev[u.email], enabled: e.target.checked },
                            }))}
                          />
                        ) : (
                          <span className={`badge ${(u.enabled ?? true) ? 'bg-success' : 'bg-danger'}`}>
                            {(u.enabled ?? true) ? 'Enabled' : 'Disabled'}
                          </span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Control
                            size="sm"
                            type="number"
                            value={editing[u.email].lossLimit}
                            onChange={e => setEditing(prev => ({
                              ...prev,
                              [u.email]: { ...prev[u.email], lossLimit: e.target.value },
                            }))}
                            style={{ width: 100 }}
                          />
                        ) : (
                          <>&#8377;{u.lossLimit.toLocaleString()}</>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Control
                            size="sm"
                            type="number"
                            value={editing[u.email].lotCount}
                            onChange={e => setEditing(prev => ({
                              ...prev,
                              [u.email]: { ...prev[u.email], lotCount: e.target.value },
                            }))}
                            style={{ width: 80 }}
                          />
                        ) : (
                          u.lotCount
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Control
                            size="sm"
                            type="number"
                            value={editing[u.email].profitSplitPercent}
                            onChange={e => setEditing(prev => ({
                              ...prev,
                              [u.email]: { ...prev[u.email], profitSplitPercent: e.target.value },
                            }))}
                            style={{ width: 80 }}
                          />
                        ) : (
                          `${u.profitSplitPercent ?? 80}%`
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Control
                            size="sm"
                            type="number"
                            placeholder="none"
                            value={editing[u.email].perOrderCap}
                            onChange={e => setEditing(prev => ({
                              ...prev,
                              [u.email]: { ...prev[u.email], perOrderCap: e.target.value },
                            }))}
                            style={{ width: 100 }}
                          />
                        ) : (
                          u.perOrderCap !== undefined ? <>&#8377;{u.perOrderCap.toLocaleString()}</> : '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Check
                            type="switch"
                            id={`useGTT-${u.email}`}
                            title="Broker GTT bracket at entry vs. in-app target/SL monitoring"
                            checked={editing[u.email].useGTT}
                            onChange={e => setEditing(prev => ({
                              ...prev,
                              [u.email]: { ...prev[u.email], useGTT: e.target.checked },
                            }))}
                          />
                        ) : (
                          <span className={`badge ${(u.useGTT ?? true) ? 'bg-secondary' : 'bg-info'}`}>
                            {(u.useGTT ?? true) ? 'GTT' : 'In-app'}
                          </span>
                        )}
                      </td>
                      <td className={pnlColor}>
                        {u.sessionPnL >= 0 ? '+' : ''}&#8377;{u.sessionPnL.toFixed(2)}
                      </td>
                      <td>{u.hasActiveTrade ? 'Yes' : 'No'}</td>
                      <td>
                        <span className={`badge ${u.emailVerified ? 'bg-success' : 'bg-secondary'}`}>
                          {u.emailVerified ? 'Verified' : 'Pending'}
                        </span>
                        {isEditing && (
                          <Button
                            size="sm"
                            variant={u.emailVerified ? 'outline-danger' : 'outline-success'}
                            className="ms-1"
                            onClick={async () => { await patchVerify(u.email, 'email', !u.emailVerified); fetchUsers(); }}
                          >
                            {u.emailVerified ? 'Unverify' : 'Verify'}
                          </Button>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${u.phoneVerified ? 'bg-success' : 'bg-secondary'}`}>
                          {u.phoneVerified ? 'Verified' : 'Pending'}
                        </span>
                        {isEditing && (
                          <Button
                            size="sm"
                            variant={u.phoneVerified ? 'outline-danger' : 'outline-success'}
                            className="ms-1"
                            onClick={async () => { await patchVerify(u.email, 'phone', !u.phoneVerified); fetchUsers(); }}
                          >
                            {u.phoneVerified ? 'Unverify' : 'Verify'}
                          </Button>
                        )}
                      </td>
                      <td>
                        {(['address', 'dob', 'pan'] as const).map(doc => {
                          const verifiedKey = `${doc}Verified` as 'addressVerified' | 'dobVerified' | 'panVerified';
                          const label = doc === 'address' ? 'Addr' : doc === 'dob' ? 'DOB' : 'PAN';
                          const isVerified = u[verifiedKey] ?? false;
                          return (
                            <div key={doc} className="d-flex align-items-center gap-1 mb-1">
                              <small className="text-muted" style={{ width: 32 }}>{label}</small>
                              <span className={`badge ${isVerified ? 'bg-success' : 'bg-secondary'}`}>
                                {isVerified ? '✓' : '–'}
                              </span>
                              {isEditing && (
                                <Button
                                  size="sm"
                                  variant={isVerified ? 'outline-danger' : 'outline-success'}
                                  className="py-0 px-1"
                                  style={{ fontSize: '0.7rem' }}
                                  onClick={async () => { await patchVerify(u.email, doc, !isVerified); fetchUsers(); }}
                                >
                                  {isVerified ? 'Unverify' : 'Verify'}
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </td>
                      <td style={stickyActionsStyle}>
                        <div className="d-flex gap-1">
                          {isEditing ? (
                            <>
                              <Button size="sm" variant="success" onClick={() => saveEdit(u.email)}>Save</Button>
                              <Button size="sm" variant="secondary" onClick={() => cancelEdit(u.email)}>Cancel</Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" variant="outline-primary" onClick={() => startEdit(u)}>Edit</Button>
                              <Button
                                size="sm"
                                variant="outline-danger"
                                onClick={() => handleDeleteUser(u.email)}
                                disabled={u.email === user?.email}
                              >
                                Delete
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {users.length === 0 && (
              <p className="text-center text-muted">No users registered yet.</p>
            )}
          </Tab>

          <Tab eventKey="config" title="Strategy Configuration">
            {configLoading ? (
              <div className="text-center py-5">
                <Spinner animation="border" />
              </div>
            ) : configError ? (
              <Alert variant="danger">{configError}</Alert>
            ) : config ? (
              <>
                {configSuccess && <Alert variant="success">Configuration saved successfully!</Alert>}

                <Card className="mb-3">
                  <Card.Header className="fw-bold">ANT Streaming</Card.Header>
                  <Card.Body>
                    <div className="d-flex justify-content-between align-items-center flex-wrap gap-3">
                      <div>
                        <div className="fw-semibold">Alice Blue live market data</div>
                        <div className="text-muted small">
                          Starts the ANT websocket feed for this server process. Run this again after every server
                          restart — the connection does not persist across restarts.
                        </div>
                      </div>
                      <Button variant="primary" onClick={connectAnt} disabled={antConnecting}>
                        {antConnecting ? 'Connecting…' : 'Connect'}
                      </Button>
                    </div>
                    {antResult && (
                      <Alert
                        className="mt-3 mb-0"
                        variant={antResult.success ? 'success' : 'danger'}
                        dismissible
                        onClose={() => setAntResult(null)}
                      >
                        {antResult.message}
                      </Alert>
                    )}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Global Settings</Card.Header>
                  <Card.Body>
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Minimum Price', ['settings', 'minPrice'], config.settings?.minPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Maximum Price', ['settings', 'maxPrice'], config.settings?.maxPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Cooldown (sec)', ['settings', 'cooldownSeconds'], config.settings?.cooldownSeconds)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Trailing Distance', ['settings', 'trailingDistance'], config.settings?.trailingDistance)}
                      </Col>
                    </Row>
                    {renderConfigField('Log Option Quotes to DB', ['settings', 'logQuotes'], config.settings?.logQuotes ?? false, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Buy-Sell Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['buySellStrategy', 'enabled'], config.buySellStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Initial Quantity', ['buySellStrategy', 'initialQuantity'], config.buySellStrategy?.initialQuantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Increment Quantity', ['buySellStrategy', 'incrementQuantity'], config.buySellStrategy?.incrementQuantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Average Threshold', ['buySellStrategy', 'averageThreshold'], config.buySellStrategy?.averageThreshold)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Price', ['buySellStrategy', 'targetPrice'], config.buySellStrategy?.targetPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Max Iteration Count', ['buySellStrategy', 'maxIterationCount'], config.buySellStrategy?.maxIterationCount)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Right', ['buySellStrategy', 'right'], config.buySellStrategy?.right, 'text')}
                      </Col>
                    </Row>
                    {renderConfigField('Stop Enabled', ['buySellStrategy', 'stopEnabled'], config.buySellStrategy?.stopEnabled, 'boolean')}
                    {renderConfigField('Log Enabled', ['buySellStrategy', 'logEnabled'], config.buySellStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Sentiment Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['sentimentStrategy', 'enabled'], config.sentimentStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Average Threshold', ['sentimentStrategy', 'averageThreshold'], config.sentimentStrategy?.averageThreshold)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Price', ['sentimentStrategy', 'targetPrice'], config.sentimentStrategy?.targetPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Order Quantity', ['sentimentStrategy', 'orderQuantity'], config.sentimentStrategy?.orderQuantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Sentiment', ['sentimentStrategy', 'sentiment'], config.sentimentStrategy?.sentiment, 'text')}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Loop Count', ['sentimentStrategy', 'loopCount'], config.sentimentStrategy?.loopCount)}
                      </Col>
                    </Row>
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Intermittent Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['intermittentStrategy', 'enabled'], config.intermittentStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Loop Count', ['intermittentStrategy', 'loopCount'], config.intermittentStrategy?.loopCount)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Price', ['intermittentStrategy', 'targetPrice'], config.intermittentStrategy?.targetPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Quantity', ['intermittentStrategy', 'quantity'], config.intermittentStrategy?.quantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Threshold', ['intermittentStrategy', 'threshold'], config.intermittentStrategy?.threshold)}
                      </Col>
                    </Row>
                    {renderConfigField('Log Enabled', ['intermittentStrategy', 'logEnabled'], config.intermittentStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Rate of Change Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['rateOfChangeStrategy', 'enabled'], config.rateOfChangeStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Points Threshold', ['rateOfChangeStrategy', 'pointsThreshold'], config.rateOfChangeStrategy?.pointsThreshold)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Acceleration Threshold', ['rateOfChangeStrategy', 'accelerationThreshold'], config.rateOfChangeStrategy?.accelerationThreshold)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Quantity', ['rateOfChangeStrategy', 'quantity'], config.rateOfChangeStrategy?.quantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Data Points Window', ['rateOfChangeStrategy', 'numberOfDatapointsReceived'], config.rateOfChangeStrategy?.numberOfDatapointsReceived)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Price', ['rateOfChangeStrategy', 'targetPrice'], config.rateOfChangeStrategy?.targetPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Stop Loss Price', ['rateOfChangeStrategy', 'stopLossPrice'], config.rateOfChangeStrategy?.stopLossPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Max Hold Time (min)', ['rateOfChangeStrategy', 'maxHoldTimeMinutes'], config.rateOfChangeStrategy?.maxHoldTimeMinutes)}
                      </Col>
                    </Row>
                    {renderConfigField('Log Enabled', ['rateOfChangeStrategy', 'logEnabled'], config.rateOfChangeStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Gap Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['gapStrategy', 'enabled'], config.gapStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Points Threshold', ['gapStrategy', 'pointsThreshold'], config.gapStrategy?.pointsThreshold)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Data Points Window', ['gapStrategy', 'numberOfDatapointsReceived'], config.gapStrategy?.numberOfDatapointsReceived)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Quantity', ['gapStrategy', 'quantity'], config.gapStrategy?.quantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Price', ['gapStrategy', 'targetPrice'], config.gapStrategy?.targetPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Stop Loss Price', ['gapStrategy', 'stopLossPrice'], config.gapStrategy?.stopLossPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Max Hold Time (min)', ['gapStrategy', 'maxHoldTimeMinutes'], config.gapStrategy?.maxHoldTimeMinutes)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Gap Reversal Threshold', ['gapStrategy', 'gapReversalThreshold'], config.gapStrategy?.gapReversalThreshold)}
                      </Col>
                    </Row>
                    {renderConfigField('Gap Reversal Mode', ['gapStrategy', 'gapReversalMode'], config.gapStrategy?.gapReversalMode, 'boolean')}
                    {renderConfigField('Log Enabled', ['gapStrategy', 'logEnabled'], config.gapStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Good Morning Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['goodMorningStrategy', 'enabled'], config.goodMorningStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Quantity', ['goodMorningStrategy', 'quantity'], config.goodMorningStrategy?.quantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Points', ['goodMorningStrategy', 'targetPoints'], config.goodMorningStrategy?.targetPoints)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Stop Loss Points', ['goodMorningStrategy', 'stopLossPoints'], config.goodMorningStrategy?.stopLossPoints)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Previous Close', ['goodMorningStrategy', 'previousClose'], config.goodMorningStrategy?.previousClose)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Snapshot Time', ['goodMorningStrategy', 'snapshotTime'], config.goodMorningStrategy?.snapshotTime, 'text')}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Confirm Time', ['goodMorningStrategy', 'confirmTime'], config.goodMorningStrategy?.confirmTime, 'text')}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Min Movement Points', ['goodMorningStrategy', 'minMovementPoints'], config.goodMorningStrategy?.minMovementPoints)}
                      </Col>
                    </Row>
                    {renderConfigField('Log Enabled', ['goodMorningStrategy', 'logEnabled'], config.goodMorningStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Good Morning Sensex Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['goodMorningSensexStrategy', 'enabled'], config.goodMorningSensexStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Quantity', ['goodMorningSensexStrategy', 'quantity'], config.goodMorningSensexStrategy?.quantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Points', ['goodMorningSensexStrategy', 'targetPoints'], config.goodMorningSensexStrategy?.targetPoints)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Stop Loss Points', ['goodMorningSensexStrategy', 'stopLossPoints'], config.goodMorningSensexStrategy?.stopLossPoints)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Previous Close', ['goodMorningSensexStrategy', 'previousClose'], config.goodMorningSensexStrategy?.previousClose)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Snapshot Time', ['goodMorningSensexStrategy', 'snapshotTime'], config.goodMorningSensexStrategy?.snapshotTime, 'text')}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Confirm Time', ['goodMorningSensexStrategy', 'confirmTime'], config.goodMorningSensexStrategy?.confirmTime, 'text')}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Min Movement Points', ['goodMorningSensexStrategy', 'minMovementPoints'], config.goodMorningSensexStrategy?.minMovementPoints)}
                      </Col>
                    </Row>
                    {renderConfigField('Log Enabled', ['goodMorningSensexStrategy', 'logEnabled'], config.goodMorningSensexStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Support/Resistance Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['supportResistanceStrategy', 'enabled'], config.supportResistanceStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Support Price', ['supportResistanceStrategy', 'supportPrice'], config.supportResistanceStrategy?.supportPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Resistance Price', ['supportResistanceStrategy', 'resistancePrice'], config.supportResistanceStrategy?.resistancePrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Quantity', ['supportResistanceStrategy', 'quantity'], config.supportResistanceStrategy?.quantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Points', ['supportResistanceStrategy', 'targetPoints'], config.supportResistanceStrategy?.targetPoints)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Stop Loss Points', ['supportResistanceStrategy', 'stopLossPoints'], config.supportResistanceStrategy?.stopLossPoints)}
                      </Col>
                    </Row>
                    {renderConfigField('Log Enabled', ['supportResistanceStrategy', 'logEnabled'], config.supportResistanceStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Target Reach Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['targetReachStrategy', 'enabled'], config.targetReachStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Symbol', ['targetReachStrategy', 'symbol'], config.targetReachStrategy?.symbol, 'text')}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Strike', ['targetReachStrategy', 'strike'], config.targetReachStrategy?.strike)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Expiry', ['targetReachStrategy', 'expiry'], config.targetReachStrategy?.expiry, 'text')}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Option Type', ['targetReachStrategy', 'optionType'], config.targetReachStrategy?.optionType, 'text')}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Price', ['targetReachStrategy', 'targetPrice'], config.targetReachStrategy?.targetPrice)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Quantity', ['targetReachStrategy', 'quantity'], config.targetReachStrategy?.quantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target Points', ['targetReachStrategy', 'targetPoints'], config.targetReachStrategy?.targetPoints)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Stop Loss Points', ['targetReachStrategy', 'stopLossPoints'], config.targetReachStrategy?.stopLossPoints)}
                      </Col>
                    </Row>
                    {renderConfigField('Log Enabled', ['targetReachStrategy', 'logEnabled'], config.targetReachStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <Card className="mb-3">
                  <Card.Header className="fw-bold">Rule Based Strategy</Card.Header>
                  <Card.Body>
                    {renderConfigField('Enabled', ['ruleBasedStrategy', 'enabled'], config.ruleBasedStrategy?.enabled, 'boolean')}
                    <Row>
                      <Col md={6}>
                        {renderConfigField('Quantity', ['ruleBasedStrategy', 'quantity'], config.ruleBasedStrategy?.quantity)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Target', ['ruleBasedStrategy', 'target'], config.ruleBasedStrategy?.target)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Stop Loss', ['ruleBasedStrategy', 'stopLoss'], config.ruleBasedStrategy?.stopLoss)}
                      </Col>
                      <Col md={6}>
                        {renderConfigField('Max Hold Time (min)', ['ruleBasedStrategy', 'maxHoldTimeMinutes'], config.ruleBasedStrategy?.maxHoldTimeMinutes)}
                      </Col>
                    </Row>
                    <Form.Group className="mb-3">
                      <Form.Label>Indicators (JSON)</Form.Label>
                      <Form.Control
                        as="textarea"
                        rows={6}
                        className="font-monospace"
                        value={JSON.stringify(config.ruleBasedStrategy?.indicators ?? [], null, 2)}
                        onChange={e => {
                          try {
                            const parsed = JSON.parse(e.target.value);
                            setIndicatorsJsonError(null);
                            updateConfigValue(['ruleBasedStrategy', 'indicators'], parsed);
                          } catch {
                            setIndicatorsJsonError('Invalid JSON — edits will not be saved until this is fixed.');
                          }
                        }}
                      />
                      {indicatorsJsonError && <div className="text-danger small mt-1">{indicatorsJsonError}</div>}
                    </Form.Group>
                    {renderConfigField('Log Enabled', ['ruleBasedStrategy', 'logEnabled'], config.ruleBasedStrategy?.logEnabled, 'boolean')}
                  </Card.Body>
                </Card>

                <div className="d-flex gap-2">
                  <Button variant="primary" onClick={saveConfig}>Save Configuration</Button>
                  <Button variant="secondary" onClick={fetchConfig}>Reset</Button>
                </div>
              </>
            ) : (
              <p className="text-center text-muted py-5">No configuration data available</p>
            )}
          </Tab>

          <Tab eventKey="payments" title="Payments">
            <Card className="mb-3">
              <Card.Header className="fw-bold">Compute Payout</Card.Header>
              <Card.Body>
                <Row className="g-2 align-items-end mb-3">
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label className="small">User</Form.Label>
                      <Form.Select size="sm" value={payoutUser} onChange={e => setPayoutUser(e.target.value)}>
                        <option value="">Select user…</option>
                        {users.map(u => <option key={u.email} value={u.email}>{u.name} ({u.email})</option>)}
                      </Form.Select>
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="small">Period From</Form.Label>
                      <Form.Control size="sm" type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="small">Period To</Form.Label>
                      <Form.Control size="sm" type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
                    </Form.Group>
                  </Col>
                  <Col md={2}>
                    <Button size="sm" variant="primary" onClick={computePayout} disabled={computing}>
                      {computing ? <Spinner animation="border" size="sm" /> : 'Compute'}
                    </Button>
                  </Col>
                </Row>

                {computeError && <Alert variant="danger" dismissible onClose={() => setComputeError(null)}>{computeError}</Alert>}

                {computed && (
                  <div className="border rounded p-3 bg-light">
                    <div className="d-flex justify-content-between"><span>Gross Profit</span><span>&#8377;{computed.grossProfit.toFixed(2)}</span></div>
                    <div className="d-flex justify-content-between">
                      <span>Profit Split ({computed.profitSplitPercent}%)</span><span>&#8377;{computed.splitAmount.toFixed(2)}</span>
                    </div>
                    <div className="d-flex justify-content-between">
                      <span>{computed.entityType === 'company' ? 'GST Registered — No TDS' : 'Individual TDS (10%)'}</span>
                      <span>&#8377;{computed.tdsAmount.toFixed(2)}</span>
                    </div>
                    <div className="d-flex justify-content-between fw-bold border-top pt-1 mt-1">
                      <span>Net Payable</span><span>&#8377;{computed.netAmount.toFixed(2)}</span>
                    </div>
                    {computed.blocked && (
                      <Alert variant="warning" className="small mt-3 mb-0">
                        ⚠ {computed.blockReason}
                      </Alert>
                    )}
                    <div className="mt-3">
                      <Form.Control
                        size="sm"
                        placeholder="Note (optional)"
                        value={payoutNote}
                        onChange={e => setPayoutNote(e.target.value)}
                        className="mb-2"
                      />
                      <Button size="sm" variant="success" onClick={createPayout}>
                        {computed.blocked ? 'Record as Rejected' : 'Create Pending Payout'}
                      </Button>
                    </div>
                  </div>
                )}
              </Card.Body>
            </Card>

            <Card>
              <Card.Header className="fw-bold d-flex justify-content-between align-items-center">
                All Payouts
                <Form.Select size="sm" style={{ width: 160 }} value={payoutsFilter} onChange={e => setPayoutsFilter(e.target.value)}>
                  <option value="">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="paid">Paid</option>
                  <option value="rejected">Rejected</option>
                </Form.Select>
              </Card.Header>
              <Card.Body className="p-0">
                {payoutsLoading ? (
                  <div className="text-center py-4"><Spinner animation="border" /></div>
                ) : adminPayouts.length === 0 ? (
                  <p className="text-center text-muted py-4 mb-0">No payouts found.</p>
                ) : (
                  <Table striped hover responsive className="mb-0">
                    <thead>
                      <tr>
                        <th>User</th><th>Period</th><th>Gross</th><th>Net</th><th>Status</th><th>Note</th><th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminPayouts.map(p => (
                        <tr key={p._id}>
                          <td>{p.user}</td>
                          <td>{new Date(p.periodStart).toLocaleDateString()} – {new Date(p.periodEnd).toLocaleDateString()}</td>
                          <td>&#8377;{p.grossProfit.toFixed(2)}</td>
                          <td>&#8377;{p.netAmount.toFixed(2)}</td>
                          <td>
                            <span className={`badge ${p.status === 'paid' ? 'bg-success' : p.status === 'rejected' ? 'bg-danger' : 'bg-warning text-dark'}`}>
                              {p.status}
                            </span>
                          </td>
                          <td className="small text-muted">{p.adminNote || '—'}</td>
                          <td>
                            {p.status === 'pending' && (
                              <div className="d-flex gap-1">
                                <Button size="sm" variant="success" disabled={decidingId === p._id} onClick={() => decidePayout(p._id, 'paid')}>Mark Paid</Button>
                                <Button size="sm" variant="outline-danger" disabled={decidingId === p._id} onClick={() => decidePayout(p._id, 'rejected')}>Reject</Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card.Body>
            </Card>
          </Tab>
        </Tabs>
      </Container>
    </div>
  );
}
