import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Table, Form, Button, Spinner, Tabs, Tab, Card, Row, Col, Alert } from 'react-bootstrap';
import { useAuth, AuthUser } from '../context/AuthContext';

interface UserRow extends AuthUser {
  sessionPnL: number;
  hasActiveTrade: boolean;
}

async function patchVerify(email: string, field: 'email' | 'phone', verified: boolean) {
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
  const [editing, setEditing] = useState<Record<string, { lossLimit: string; lotCount: string; role: string; enabled: boolean }>>({});
  const [config, setConfig] = useState<any>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState('users');
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', name: '', lossLimit: '15000', lotCount: '10', role: 'user' });
  const [userError, setUserError] = useState<string | null>(null);

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
      [u.email]: { lossLimit: String(u.lossLimit), lotCount: String(u.lotCount), role: u.role, enabled: u.enabled ?? true },
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
                  <th>Session P&amp;L</th>
                  <th>Active</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Actions</th>
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

                <div className="d-flex gap-2">
                  <Button variant="primary" onClick={saveConfig}>Save Configuration</Button>
                  <Button variant="secondary" onClick={fetchConfig}>Reset</Button>
                </div>
              </>
            ) : (
              <p className="text-center text-muted py-5">No configuration data available</p>
            )}
          </Tab>
        </Tabs>
      </Container>
    </div>
  );
}
