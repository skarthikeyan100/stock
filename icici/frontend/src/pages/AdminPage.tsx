import { useState, useEffect, useRef, CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Container, Table, Form, Button, Spinner, Tabs, Tab, Card, Row, Col, Alert, OverlayTrigger, Tooltip, Modal, Accordion } from 'react-bootstrap';
import { useAuth, AuthUser } from '../context/AuthContext';
import DateRangeFilter, { DateRange, resolveDateRange, formatRangeLabel } from '../components/DateRangeFilter';

interface UserRow extends AuthUser {
  sessionPnL: number;
  hasActiveTrade: boolean;
}

// Config key -> the exact `user` value trades are tagged with, for the
// Strategy Configuration tab's per-strategy Realized/Unrealized P&L badge.
// Derived from `StrategyFactory.STRATEGY_REGISTRY` + config.yml (userId
// defaults to `type` when no explicit `userId:` override exists, which is the
// case for every one of these). `buySellStrategy`/`intermittentStrategy` have
// no config.yml entry at all (legacy/dead UI - see strategies.md) so they get
// no badge. `ruleBasedStrategy` is also left out: its actual runtime userId
// is dynamically derived per indicator group by `expandRuleBasedConfig`
// (e.g. 'Rule-RSI_5_80_20, EMA_5_13'), not the literal class name, so a
// single fixed mapping here would silently show an always-empty P&L.
const STRATEGY_PNL_USER: Record<string, string> = {
  continuousStrategy: 'ContinuousStrategy',
  sentimentStrategy: 'SentimentStrategy',
  rateOfChangeStrategy: 'RateOfChangeStrategy',
  gapStrategy: 'GapStrategy',
  goodMorningStrategy: 'GoodMorningStrategy',
  goodMorningSensexStrategy: 'GoodMorningSensexStrategy',
  supportResistanceStrategy: 'SupportResistanceStrategy',
  targetReachStrategy: 'TargetReachStrategy',
  bulkPcrStrategy: 'BulkPcrStrategy',
};

// Today's realized (closed trades) + unrealized (open trades, marked to last
// trade price) P&L - same aggregation the Bulk PCR status popover used to do
// for itself alone, now shared across every strategy's collapsed-row badge.
function computeTodayPnl(open: any[], closed: any[]): { realized: number; unrealized: number } {
  const today = new Date().toISOString().split('T')[0];
  const todaysClosed = (closed || []).filter(t => {
    const dateStr = t.exitTime || t.closedAt || t.date;
    if (!dateStr) return true;
    const tradeDate = new Date(dateStr);
    if (isNaN(tradeDate.getTime())) return true;
    return tradeDate.toISOString().split('T')[0] === today;
  });
  const todaysOpen = (open || []).filter(t => {
    const dateStr = t.entryTime || t.openedAt || t.date;
    if (!dateStr) return true;
    const tradeDate = new Date(dateStr);
    if (isNaN(tradeDate.getTime())) return true;
    return tradeDate.toISOString().split('T')[0] === today;
  });
  const realized = todaysClosed.reduce((s, t) => s + (t.realizedPnL || 0), 0);
  const unrealized = todaysOpen.reduce((s, t) => s + ((t.lastTradePrice - t.price) * t.quantity || 0), 0);
  return { realized, unrealized };
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

interface UserEditRow {
  lossLimit: string; lotCount: string; role: string; enabled: boolean; useGTT: boolean;
  profitSplitPercent: string; perOrderCap: string; allottedCapital: string; targetPoints: string;
  stopLossPoints: string; investmentAmount: string;
}

export default function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Record<string, UserEditRow>>({});
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
  const [payoutPeriod, setPayoutPeriod] = useState<DateRange>(() => resolveDateRange('month', '', ''));
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [computed, setComputed] = useState<any>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [payoutNote, setPayoutNote] = useState('');
  const [adminPayouts, setAdminPayouts] = useState<any[]>([]);
  const [payoutsFilter, setPayoutsFilter] = useState('');
  const [payoutsLoading, setPayoutsLoading] = useState(true);

  // Trades tab
  const [strategies, setStrategies] = useState<{ type: string; userId: string; enabled: boolean }[]>([]);
  const [tradeUser, setTradeUser] = useState(() => searchParams.get('tradeUser') || '__all__');
  const [tradeDateRange, setTradeDateRange] = useState<DateRange>(() => {
    const mode = (searchParams.get('tradeMode') as DateRange['mode']) || 'day';
    return resolveDateRange(mode, searchParams.get('tradeFrom') || '', searchParams.get('tradeTo') || '');
  });
  const [openTradesList, setOpenTradesList] = useState<any[]>([]);
  const [closedTradesList, setClosedTradesList] = useState<any[]>([]);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [pnlSummary, setPnlSummary] = useState<any>(null);

  // Strategy Configuration tab - per-strategy Realized/Unrealized P&L badges
  const [strategyPnl, setStrategyPnl] = useState<Record<string, { realized: number; unrealized: number }>>({});

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

  useEffect(() => {
    if (activeTab !== 'trades') return;
    fetch('/strategies')
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setStrategies(data); })
      .catch(() => {});
  }, [activeTab]);

  const loadTrades = async () => {
    setTradesError(null);
    setTradesLoading(true);
    try {
      const userQs = tradeUser === '__all__' ? '' : `user=${encodeURIComponent(tradeUser)}`;
      const closedQs = new URLSearchParams();
      if (tradeUser !== '__all__') closedQs.set('user', tradeUser);
      if (tradeDateRange.from) closedQs.set('from', tradeDateRange.from);
      if (tradeDateRange.to) closedQs.set('to', tradeDateRange.to);
      const [openRes, closedRes] = await Promise.all([
        fetch(`/admin/trades/open${userQs ? `?${userQs}` : ''}`),
        fetch(`/admin/trades/closed?${closedQs.toString()}`),
      ]);
      const [openData, closedData] = await Promise.all([openRes.json(), closedRes.json()]);
      setOpenTradesList(Array.isArray(openData) ? openData : []);
      setClosedTradesList(Array.isArray(closedData) ? closedData : []);
    } catch (e: any) {
      setTradesError(e.message || 'Failed to load trades');
    } finally {
      setTradesLoading(false);
    }
  };


  // Auto-fetch (debounced) on user/date-range change instead of a manual Load
  // click - see Analysis.md's admin-trade-filtering finding.
  useEffect(() => {
    if (activeTab !== 'trades') return;
    const timer = setTimeout(loadTrades, 300);
    return () => clearTimeout(timer);
  }, [activeTab, tradeUser, tradeDateRange.from, tradeDateRange.to]);

  // Refreshes every strategy's today's Realized/Unrealized P&L badge while the
  // Strategy Configuration tab is open - same tab-scoped-polling convention
  // the Trades/Payments/Users tabs already use above.
  useEffect(() => {
    if (activeTab !== 'config') return;
    const fetchAllPnl = async () => {
      const entries = await Promise.all(
        Object.entries(STRATEGY_PNL_USER).map(async ([configKey, pnlUser]) => {
          try {
            const [openRes, closedRes] = await Promise.all([
              fetch(`/admin/trades/open?user=${encodeURIComponent(pnlUser)}`),
              fetch(`/admin/trades/closed?user=${encodeURIComponent(pnlUser)}`),
            ]);
            const [openData, closedData] = await Promise.all([openRes.json(), closedRes.json()]);
            return [configKey, computeTodayPnl(Array.isArray(openData) ? openData : [], Array.isArray(closedData) ? closedData : [])] as const;
          } catch {
            return [configKey, { realized: 0, unrealized: 0 }] as const;
          }
        })
      );
      setStrategyPnl(Object.fromEntries(entries));
    };
    fetchAllPnl();
    const interval = setInterval(fetchAllPnl, 20000);
    return () => clearInterval(interval);
  }, [activeTab]);

  // "Eligible" P&L (excludes forfeited profit) - only meaningful for a single
  // user, since forfeiture is checked against that user's investmentAmount.
  // Day mode needs no fetch (see the plain-sum banner rendered below).
  useEffect(() => {
    if (activeTab !== 'trades') return;
    if (tradeUser === '__all__' || tradeDateRange.mode === 'day') {
      setPnlSummary(null);
      return;
    }
    const qs = new URLSearchParams({ user: tradeUser, from: tradeDateRange.from, to: tradeDateRange.to });
    if (tradeDateRange.mode === 'month') qs.set('breakdown', 'week');
    const timer = setTimeout(() => {
      fetch(`/admin/trades/pnl-summary?${qs.toString()}`)
        .then(res => res.json())
        .then(data => setPnlSummary(data))
        .catch(() => setPnlSummary(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [activeTab, tradeUser, tradeDateRange.mode, tradeDateRange.from, tradeDateRange.to]);

  useEffect(() => {
    if (activeTab !== 'trades') return;
    const next = new URLSearchParams(searchParams);
    next.set('tradeUser', tradeUser);
    next.set('tradeMode', tradeDateRange.mode);
    next.set('tradeFrom', tradeDateRange.from);
    next.set('tradeTo', tradeDateRange.to);
    setSearchParams(next, { replace: true });
  }, [activeTab, tradeUser, tradeDateRange]);

  const computePayout = async () => {
    setComputeError(null);
    setComputed(null);
    if (!payoutUser || !payoutPeriod.from || !payoutPeriod.to) {
      setComputeError('Select a user and both dates');
      return;
    }
    setComputing(true);
    try {
      const res = await fetch('/admin/payouts/compute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: payoutUser, periodStart: payoutPeriod.from, periodEnd: payoutPeriod.to }),
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
        body: JSON.stringify({ user: payoutUser, periodStart: payoutPeriod.from, periodEnd: payoutPeriod.to }),
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

  // Per-row debounce timers for the Users table's autosave.
  const editAutoSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Skips the config-autosave effect when `config` changes because we just
  // fetched it (initial load / Reset), not because the admin edited a field.
  const skipNextConfigAutoSaveRef = useRef(true);

  useEffect(() => {
    fetchUsers();
    if (activeTab !== 'users') return;
    const interval = setInterval(fetchUsers, 5000);
    return () => clearInterval(interval);
  }, [activeTab]);

  const fetchConfig = () => {
    setConfigLoading(true);
    setConfigError(null);
    skipNextConfigAutoSaveRef.current = true; // this setConfig call is a load, not an edit - don't autosave it back
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

  // Resolved (actual, in-effect) values for the per-user override fields -
  // what the user gets right now when they have no explicit override.
  const userDefaults = {
    allottedCapital: config?.continuousStrategy?.allottedCapital,
    targetPoints: config?.settings?.targetPriceDiff,
    stopLossPoints: config?.settings?.stopLossPriceDiff,
  };

  const startEdit = (u: UserRow) => {
    setEditing(prev => ({
      ...prev,
      [u.email]: {
        lossLimit: String(u.lossLimit), lotCount: String(u.lotCount), role: u.role, enabled: u.enabled ?? true, useGTT: u.useGTT ?? true,
        profitSplitPercent: String(u.profitSplitPercent ?? 80), perOrderCap: u.perOrderCap !== undefined ? String(u.perOrderCap) : '',
        // Show the actual value in effect (override, else the resolved
        // default) rather than a blank field with a "default" placeholder.
        allottedCapital: String(u.allottedCapital ?? userDefaults.allottedCapital ?? ''),
        targetPoints: String(u.targetPoints ?? userDefaults.targetPoints ?? ''),
        stopLossPoints: String(u.stopLossPoints ?? userDefaults.stopLossPoints ?? ''),
        investmentAmount: String(u.investmentAmount ?? 100000),
      },
    }));
  };

  // Flushes any pending autosave for this row, then locks it back to read-only.
  const cancelEdit = (email: string) => {
    if (editAutoSaveTimers.current[email]) {
      clearTimeout(editAutoSaveTimers.current[email]);
      delete editAutoSaveTimers.current[email];
      saveEdit(email);
    }
    setEditing(prev => {
      const next = { ...prev };
      delete next[email];
      return next;
    });
  };

  // `valsOverride` lets a caller pass an exact snapshot instead of reading
  // `editing[email]` - needed by the autosave debounce, since by the time its
  // timer fires the `editing` state closure it would otherwise read from can
  // be one keystroke stale relative to what was just typed.
  const saveEdit = async (email: string, valsOverride?: UserEditRow) => {
    const vals = valsOverride ?? editing[email];
    if (!vals) return;
    try {
      // A field left equal to its resolved default stays "no override" so it
      // keeps tracking the global/strategy default if that changes later.
      const allottedCapital = vals.allottedCapital === '' || Number(vals.allottedCapital) === userDefaults.allottedCapital
        ? undefined : Number(vals.allottedCapital);
      const targetPoints = vals.targetPoints === '' || Number(vals.targetPoints) === userDefaults.targetPoints
        ? undefined : Number(vals.targetPoints);
      const stopLossPoints = vals.stopLossPoints === '' || Number(vals.stopLossPoints) === userDefaults.stopLossPoints
        ? undefined : Number(vals.stopLossPoints);
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
          allottedCapital,
          targetPoints,
          stopLossPoints,
          investmentAmount: Number(vals.investmentAmount),
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
      fetchUsers();
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  // Updates one field of a row's edit buffer and (re)schedules its debounced
  // autosave - no explicit "Save" click needed. The merged row is captured
  // now and handed to saveEdit directly (see its comment) rather than left
  // for the timer to re-read from state later.
  const updateEditingField = (email: string, patch: Partial<UserEditRow>) => {
    const merged = { ...editing[email], ...patch };
    setEditing(prev => ({ ...prev, [email]: merged }));
    if (editAutoSaveTimers.current[email]) clearTimeout(editAutoSaveTimers.current[email]);
    editAutoSaveTimers.current[email] = setTimeout(() => {
      delete editAutoSaveTimers.current[email];
      saveEdit(email, merged);
    }, 800);
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

  // Autosaves the Strategy Configuration form (debounced) whenever `config`
  // changes from an edit - skipped for the setConfig calls fetchConfig makes
  // (initial load / Reset), which aren't edits.
  useEffect(() => {
    if (!config) return;
    if (skipNextConfigAutoSaveRef.current) {
      skipNextConfigAutoSaveRef.current = false;
      return;
    }
    const t = setTimeout(() => { saveConfig(); }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

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

  const handleResetContinuousStrategy = async () => {
    if (!confirm('Reset Continuous Strategy? This clears ALL in-memory leg tracking (open positions become untracked at the app level, though they remain open at the broker) and re-arms new entries from scratch. Only use this if you understand the current open-position state.')) return;
    try {
      const res = await fetch('/strategies/ContinuousStrategy/reset');
      if (!res.ok) throw new Error('Failed to reset strategy');
    } catch (err) {
      console.error('Reset strategy error:', err);
      alert('Failed to reset strategy');
    }
  };

  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center min-vh-100">
        <Spinner animation="border" />
      </div>
    );
  }

  // One-line description + possible-values hint per config field, shown in a
  // hover tooltip next to its label. Keyed by path.join('.') so renderConfigField
  // (and the hand-written Indicators textarea below) can look themselves up -
  // no call site needs to pass this explicitly. A field with no entry here just
  // renders without a tooltip icon (see fieldLabel).
  const FIELD_HELP: Record<string, { description: string; values: string }> = {
    'settings.minPrice': { description: "Skip generating a buy signal when the option's LTP is below this floor.", values: 'Integer, in ₹ (e.g. 20).' },
    'settings.maxPrice': { description: "Skip generating a buy signal when the option's LTP is above this ceiling.", values: 'Integer, in ₹ (e.g. 30000).' },
    'settings.cooldownSeconds': { description: 'Minimum wait after an exit before a new entry can be attempted.', values: 'Integer seconds (e.g. 60).' },
    'settings.trailingDistance': { description: 'Distance the trailing stop trails behind the best price seen since entry.', values: 'Integer points.' },
    'settings.logQuotes': { description: "Persist every incoming option tick to Mongo's OptionQuote collection.", values: 'On/Off — heavy write volume when enabled.' },

    'buySellStrategy.enabled': { description: 'Turn this strategy on/off — disabled strategies never place new entries.', values: 'On/Off.' },
    'buySellStrategy.initialQuantity': { description: 'Lot size of the first entry.', values: 'Integer, must match the instrument lot size.' },
    'buySellStrategy.incrementQuantity': { description: 'Additional quantity added on each averaging step.', values: 'Integer.' },
    'buySellStrategy.averageThreshold': { description: 'Adverse points moved (below last buy price) before averaging into the position.', values: 'Integer points.' },
    'buySellStrategy.targetPrice': { description: 'Profit target, in points above average entry, that closes the position.', values: 'Integer points.' },
    'buySellStrategy.maxIterationCount': { description: 'Maximum number of times this strategy will average into a losing position before giving up.', values: 'Integer, e.g. 3.' },
    'buySellStrategy.right': { description: 'Restrict entries to calls or puts, or leave unset for either.', values: "'CE', 'PE', or 'none'." },
    'buySellStrategy.stopEnabled': { description: 'Enforce a hard stop-loss exit in addition to averaging.', values: 'On/Off.' },
    'buySellStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },

    'continuousStrategy.enabled': { description: 'Turn this strategy on/off. Disabled: no new T1 entries, but already-open legs keep hedging/averaging/exiting normally.', values: 'On/Off.' },
    'continuousStrategy.initialQuantity': { description: 'Lot size of the root T1 entry.', values: 'Integer, must match the instrument lot size.' },
    'continuousStrategy.slDistance': { description: 'Adverse-move step size (premium points) between each hedge/average level (levels 1-4).', values: 'Integer points, e.g. 10.' },
    'continuousStrategy.squareOffDistance': { description: 'Adverse move (premium points) from entry at which the leg is force-sold at market and abandoned for good, regardless of hedging/averaging already in place.', values: 'Integer points, independent of SL Distance. Default 50.' },
    'continuousStrategy.minPremium': { description: 'Lowest option premium a contract must have to be eligible for a T1 entry or hedge spawn.', values: 'Integer, in ₹ premium, default 100.' },
    'continuousStrategy.maxInvestment': { description: 'Total capital (qty × price, across all open legs + pending refills) this strategy may deploy before new orders are permanently blocked for the session.', values: 'Integer, in ₹.' },
    'continuousStrategy.spawnQuantityMode': { description: "Multiplier applied to a leg's current size when spawning an opposite-direction hedge at an adverse level.", values: 'Positive number, e.g. 2 = double. Falls back to 1 if missing/non-numeric/≤0.' },
    'continuousStrategy.maxProfit': { description: 'Cumulative realized+unrealized profit, as a % of Max Investment, at which every open leg is closed and new entries are permanently blocked for the session.', values: 'Percent, e.g. 2. Leave unset to disable.' },
    'continuousStrategy.right': { description: 'Restrict T1 entries to calls or puts, or resolve the direction automatically from PCR.', values: "'CE', 'PE', or 'none' for PCR-based auto-resolve." },
    'continuousStrategy.cooldownSeconds': { description: 'Minimum wait after a T1 entry before another T1 entry can be attempted.', values: 'Integer seconds, default 60.' },
    'continuousStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines (spawn/average/refill messages).", values: 'On/Off.' },

    'sentimentStrategy.enabled': { description: 'Turn this strategy on/off.', values: 'On/Off.' },
    'sentimentStrategy.averageThreshold': { description: 'Adverse points moved (below last buy price) before averaging into the position.', values: 'Integer points.' },
    'sentimentStrategy.targetPrice': { description: 'Profit target, in points above average entry, that closes the position.', values: 'Integer points.' },
    'sentimentStrategy.orderQuantity': { description: 'Lot size used for every entry/average.', values: 'Integer, must match the instrument lot size.' },
    'sentimentStrategy.sentiment': { description: 'Fixed market direction this strategy always trades.', values: "'call', 'put', or 'any' to let each entry decide." },
    'sentimentStrategy.loopCount': { description: 'Maximum number of entry cycles per day before this strategy stops for the session.', values: 'Integer, e.g. 3.' },

    'intermittentStrategy.enabled': { description: 'Turn this strategy on/off.', values: 'On/Off.' },
    'intermittentStrategy.loopCount': { description: 'Maximum number of entry cycles per day before this strategy stops for the session.', values: 'Integer, e.g. 3.' },
    'intermittentStrategy.targetPrice': { description: 'Profit target, in points above entry, that closes the position.', values: 'Integer points.' },
    'intermittentStrategy.quantity': { description: 'Lot size used for every entry.', values: 'Integer, must match the instrument lot size.' },
    'intermittentStrategy.threshold': { description: 'Adverse points moved (below last price) that triggers the next buy.', values: 'Integer points.' },
    'intermittentStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },

    'rateOfChangeStrategy.enabled': { description: 'Turn this strategy on/off.', values: 'On/Off.' },
    'rateOfChangeStrategy.pointsThreshold': { description: "NIFTY's velocity (points moved over the datapoint window) must reach this magnitude to trigger an entry.", values: 'Integer points, checked as ±value.' },
    'rateOfChangeStrategy.accelerationThreshold': { description: "NIFTY's acceleration (change in velocity) must reach this magnitude to trigger/confirm an entry.", values: 'Integer points, checked as ±value.' },
    'rateOfChangeStrategy.quantity': { description: 'Lot size used for the entry.', values: 'Integer, must match the instrument lot size.' },
    'rateOfChangeStrategy.numberOfDatapointsReceived': { description: 'Number of recent NIFTY ticks used to compute velocity/acceleration.', values: 'Integer count of datapoints, e.g. 50.' },
    'rateOfChangeStrategy.targetPrice': { description: 'Profit target, in points above entry, that closes the position.', values: 'Integer points.' },
    'rateOfChangeStrategy.stopLossPrice': { description: 'Loss, in points below entry, that force-closes the position.', values: 'Integer points.' },
    'rateOfChangeStrategy.maxHoldTimeMinutes': { description: 'Force-close the position after this much time in the trade regardless of price.', values: 'Integer minutes.' },
    'rateOfChangeStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },

    'gapStrategy.enabled': { description: 'Turn this strategy on/off.', values: 'On/Off.' },
    'gapStrategy.pointsThreshold': { description: "Today's opening gap from previous close must reach this magnitude to trigger an entry.", values: 'Integer points, checked as ±value.' },
    'gapStrategy.numberOfDatapointsReceived': { description: 'Number of recent NIFTY ticks required before the gap check is evaluated.', values: 'Integer count of datapoints, e.g. 50.' },
    'gapStrategy.quantity': { description: 'Lot size used for the entry.', values: 'Integer, must match the instrument lot size.' },
    'gapStrategy.targetPrice': { description: 'Profit target, in points above entry, that closes the position.', values: 'Integer points.' },
    'gapStrategy.stopLossPrice': { description: 'Loss, in points below entry, that force-closes the position.', values: 'Integer points.' },
    'gapStrategy.maxHoldTimeMinutes': { description: 'Force-close the position after this much time in the trade regardless of price.', values: 'Integer minutes.' },
    'gapStrategy.gapReversalThreshold': { description: 'When Gap Reversal Mode is on, a gap larger than this is treated as likely to reverse (fade the gap) instead of continue.', values: 'Integer points.' },
    'gapStrategy.gapReversalMode': { description: 'Fade large gaps (trade against the gap direction) instead of always trading with the gap.', values: 'On/Off.' },
    'gapStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },

    'goodMorningStrategy.enabled': { description: 'Turn this strategy on/off.', values: 'On/Off.' },
    'goodMorningStrategy.quantity': { description: 'Lot size used for the entry.', values: 'Integer, must match the instrument lot size.' },
    'goodMorningStrategy.targetPoints': { description: 'Profit target, in points above entry, that closes the position.', values: 'Integer points.' },
    'goodMorningStrategy.stopLossPoints': { description: 'Loss, in points below entry, that force-closes the position.', values: 'Integer points.' },
    'goodMorningStrategy.previousClose': { description: "Baseline NIFTY close price this strategy compares the snapshot-time price against. Auto-updated after each trade/skip cycle.", values: 'Integer, in NIFTY points.' },
    'goodMorningStrategy.snapshotTime': { description: 'Time of day the strategy records its reference NIFTY price.', values: "'HH:mm' 24h format, e.g. '10:00'." },
    'goodMorningStrategy.confirmTime': { description: 'Time of day the strategy checks whether the move from the snapshot price has held, and enters if so.', values: "'HH:mm' 24h format, e.g. '10:30'." },
    'goodMorningStrategy.minMovementPoints': { description: 'Minimum NIFTY movement between snapshot and confirm time required to enter.', values: 'Integer points.' },
    'goodMorningStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },

    'goodMorningSensexStrategy.enabled': { description: 'Turn this strategy on/off.', values: 'On/Off.' },
    'goodMorningSensexStrategy.quantity': { description: 'Lot size used for the entry.', values: 'Integer, must match the instrument lot size.' },
    'goodMorningSensexStrategy.targetPoints': { description: 'Profit target, in points above entry, that closes the position.', values: 'Integer points.' },
    'goodMorningSensexStrategy.stopLossPoints': { description: 'Loss, in points below entry, that force-closes the position.', values: 'Integer points.' },
    'goodMorningSensexStrategy.previousClose': { description: 'Baseline SENSEX close price this strategy compares the snapshot-time price against. Auto-updated after each trade/skip cycle.', values: 'Integer, in SENSEX points.' },
    'goodMorningSensexStrategy.snapshotTime': { description: 'Time of day the strategy records its reference SENSEX price.', values: "'HH:mm' 24h format, e.g. '09:40'." },
    'goodMorningSensexStrategy.confirmTime': { description: 'Time of day the strategy checks whether the move from the snapshot price has held, and enters if so.', values: "'HH:mm' 24h format, e.g. '09:45'." },
    'goodMorningSensexStrategy.minMovementPoints': { description: 'Minimum SENSEX movement between snapshot and confirm time required to enter.', values: 'Integer points.' },
    'goodMorningSensexStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },

    'supportResistanceStrategy.enabled': { description: 'Turn this strategy on/off. Entries fire off the dynamic support/resistance breach detector (see the srHypothesis section above), not a fixed NIFTY level.', values: 'On/Off.' },
    'supportResistanceStrategy.quantity': { description: 'Lot size of the root entry.', values: 'Integer, must match the instrument lot size.' },
    'supportResistanceStrategy.slDistance': { description: 'Adverse-move step size (premium points) between each hedge/average level.', values: 'Integer points, e.g. 10.' },
    'supportResistanceStrategy.squareOffDistance': { description: 'Adverse move (premium points) from entry at which the leg is force-sold at market and abandoned for good.', values: 'Integer points, independent of SL Distance.' },
    'supportResistanceStrategy.maxLevels': { description: 'Number of stacked hedge/average levels between entry and the hard square-off.', values: 'Integer, e.g. 4.' },
    'supportResistanceStrategy.minPremium': { description: 'Lowest option premium a contract must have to be eligible for an entry or hedge spawn.', values: 'Integer, in ₹ premium.' },
    'supportResistanceStrategy.maxInvestment': { description: 'Total capital (qty × price, across all open legs + pending refills) this strategy may deploy before new orders are permanently blocked for the session.', values: 'Integer, in ₹.' },
    'supportResistanceStrategy.maxProfit': { description: 'Cumulative realized+unrealized profit, as a % of Max Investment, at which every open leg is closed and new entries are permanently blocked for the session.', values: 'Percent, e.g. 2. Leave unset to disable.' },
    'supportResistanceStrategy.spawnQuantityMode': { description: "Multiplier applied to a leg's current size when spawning an opposite-direction hedge at an adverse level.", values: 'Positive number, e.g. 2 = double. Falls back to 1 if missing/non-numeric/≤0.' },
    'supportResistanceStrategy.cooldownSeconds': { description: 'Minimum wait after an entry before another entry can be attempted.', values: 'Integer seconds, default 60.' },
    'supportResistanceStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },

    'targetReachStrategy.enabled': { description: 'Turn this strategy on/off.', values: 'On/Off.' },
    'targetReachStrategy.symbol': { description: 'Underlying index for the specific option contract this strategy watches.', values: "'NIFTY' or 'SENSEX'." },
    'targetReachStrategy.strike': { description: 'Strike price of the exact option contract this strategy watches.', values: 'Integer strike price.' },
    'targetReachStrategy.expiry': { description: 'Expiry date of the exact option contract this strategy watches.', values: "Date string, e.g. '2026-01-01'." },
    'targetReachStrategy.optionType': { description: 'Whether the watched contract is a call or a put.', values: "'CE' or 'PE'." },
    'targetReachStrategy.targetPrice': { description: "Entry trigger: the strategy buys once this contract's own LTP reaches this price.", values: 'Integer, in ₹ premium.' },
    'targetReachStrategy.quantity': { description: 'Lot size used for the entry.', values: 'Integer, must match the instrument lot size.' },
    'targetReachStrategy.targetPoints': { description: 'Profit target, in points above entry, that closes the position (applied after entry, separate from the entry trigger above).', values: 'Integer points.' },
    'targetReachStrategy.stopLossPoints': { description: 'Loss, in points below entry, that force-closes the position.', values: 'Integer points.' },
    'targetReachStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },

    'ruleBasedStrategy.enabled': { description: 'Turn this rule on/off.', values: 'On/Off.' },
    'ruleBasedStrategy.quantity': { description: 'Lot size used for the entry.', values: 'Integer, must match the instrument lot size, e.g. 65 for NIFTY.' },
    'ruleBasedStrategy.target': { description: 'Profit target, in points above entry, that closes the position.', values: 'Integer points.' },
    'ruleBasedStrategy.stopLoss': { description: 'Loss, in points below entry, that force-closes the position.', values: 'Integer points.' },
    'ruleBasedStrategy.maxHoldTimeMinutes': { description: 'Force-close the position after this much time in the trade regardless of price.', values: 'Integer minutes.' },
    'ruleBasedStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },
    'ruleBasedStrategy.indicators': { description: 'Technical indicators this rule evaluates to decide entries — one string per indicator, encoding its parameters.', values: "e.g. 'RSI_5_80_20' (RSI, period 5, overbought 80, oversold 20), 'MACD_12_26_9', 'EMA_5_13', 'Bollinger_20_2', 'ADX_14', 'Stochastic_14_3'. Must be valid JSON array of strings." },

    'bulkPcrStrategy.enabled': { description: 'Turn this one-shot strategy on/off. It durably disables itself (writes enabled: false back to config.yml) after completing one full buy → target → sell cycle.', values: 'On/Off.' },
    'bulkPcrStrategy.broker': { description: "Legacy single-broker field - only used as a fallback when no boxes are checked below.", values: "'breeze' or 'zerodha'." },
    'bulkPcrStrategy.brokers': { description: 'Which broker(s) place this block order. Checking more than one places the FULL configured quantity independently on each broker at once (not a split) - e.g. 13975 qty on Zerodha AND 13975 qty on Breeze. One PCR decision drives all of them; the cycle only self-disables once every checked broker is fully sold.', values: 'One or more of: Zerodha, Breeze.' },
    'bulkPcrStrategy.quantity': { description: 'Total quantity bought in one go, on each selected broker; split into exchange-compliant chunks automatically (NIFTY freeze quantity is 1755).', values: 'Integer, must be a multiple of the instrument lot size. Default 13975 (215 lots × 65).' },
    'bulkPcrStrategy.targetPoints': { description: 'Profit target, in points above entry average, that triggers the exit. There is no stop-loss — the position holds indefinitely until this is hit.', values: 'Integer points.' },
    'bulkPcrStrategy.right': { description: 'Fixed entry direction, or auto-resolve from PCR (put/call OI ratio) when left as none.', values: "'call', 'put', or 'none' for PCR-based auto-resolve." },
    'bulkPcrStrategy.maxInvestment': { description: 'Reference figure for total capital this block order deploys (quantity × price). This is a per-account cap shared across every broker checked above, not per broker - with 2 brokers checked, both run under the same combined limit, so size this for the FULL combined exposure (roughly 2× a single-broker figure) or one broker can get rejected while the other succeeds.', values: 'Integer, in ₹.' },
    'bulkPcrStrategy.logEnabled': { description: "Write this strategy's own decision/trade log lines.", values: 'On/Off.' },
  };

  // Adds a hover ⓘ icon next to a field's label showing its FIELD_HELP entry
  // (description + possible values), looked up by the field's own config path -
  // so renderConfigField's call sites never need to pass this explicitly. Falls
  // back to the plain label when no entry exists (safe for any field not yet
  // covered above).
  const fieldLabel = (label: string, path: string[]): React.ReactNode => {
    const help = FIELD_HELP[path.join('.')];
    if (!help) return label;
    return (
      <OverlayTrigger placement="top" overlay={<Tooltip>{help.description} Possible values: {help.values}</Tooltip>}>
        <span style={{ cursor: 'help', borderBottom: '1px dotted #6c757d' }}>
          {label} <span style={{ color: '#6c757d' }}>&#9432;</span>
        </span>
      </OverlayTrigger>
    );
  };

  const renderConfigField = (label: string, path: string[], value: any, type: 'number' | 'boolean' | 'text' | 'select' = 'number', options?: string[]) => {
    if (type === 'boolean') {
      return (
        <Form.Check
          type="switch"
          label={fieldLabel(label, path)}
          checked={value}
          onChange={e => updateConfigValue(path, e.target.checked)}
        />
      );
    }
    if (type === 'select') {
      return (
        <Form.Group className="mb-3">
          <Form.Label>{fieldLabel(label, path)}</Form.Label>
          <Form.Select value={value} onChange={e => updateConfigValue(path, e.target.value)}>
            {(options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </Form.Select>
        </Form.Group>
      );
    }
    return (
      <Form.Group className="mb-3">
        <Form.Label>{fieldLabel(label, path)}</Form.Label>
        <Form.Control
          type={type}
          value={value}
          onChange={e => updateConfigValue(path, type === 'number' ? Number(e.target.value) : e.target.value)}
        />
      </Form.Group>
    );
  };

  // Shared table renderers for open/closed trades - used by both the Trades

  return (
    <div className="min-vh-100 bg-light">
      <div className="bg-dark bg-opacity-10 border-bottom">
        <Container className="py-2 d-flex justify-content-between align-items-center">
          <span className="fw-bold">Admin Dashboard</span>
          <div className="d-flex align-items-center gap-3">
            <Button variant="outline-secondary" size="sm" onClick={() => navigate('/trade')}>← Trading</Button>
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
                  <th>Investment Amount</th>
                  <th>Profit Split %</th>
                  <th>Per-Order Cap</th>
                  <th>Allotted Capital</th>
                  <th>Target Pts</th>
                  <th>Stop-Loss Pts</th>
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
                            onChange={e => updateEditingField(u.email, { role: e.target.value })}
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
                            onChange={e => updateEditingField(u.email, { enabled: e.target.checked })}
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
                            onChange={e => updateEditingField(u.email, { lossLimit: e.target.value })}
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
                            onChange={e => updateEditingField(u.email, { lotCount: e.target.value })}
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
                            value={editing[u.email].investmentAmount}
                            onChange={e => updateEditingField(u.email, { investmentAmount: e.target.value })}
                            style={{ width: 110 }}
                          />
                        ) : (
                          <>&#8377;{(u.investmentAmount ?? 100000).toLocaleString()}</>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Control
                            size="sm"
                            type="number"
                            value={editing[u.email].profitSplitPercent}
                            onChange={e => updateEditingField(u.email, { profitSplitPercent: e.target.value })}
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
                            onChange={e => updateEditingField(u.email, { perOrderCap: e.target.value })}
                            style={{ width: 100 }}
                          />
                        ) : (
                          u.perOrderCap != null ? <>&#8377;{u.perOrderCap.toLocaleString()}</> : '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Control
                            size="sm"
                            type="number"
                            value={editing[u.email].allottedCapital}
                            onChange={e => updateEditingField(u.email, { allottedCapital: e.target.value })}
                            style={{ width: 120 }}
                          />
                        ) : (
                          (u.allottedCapital ?? userDefaults.allottedCapital) != null
                            ? <span title={u.allottedCapital == null ? 'strategy default' : undefined}>&#8377;{(u.allottedCapital ?? userDefaults.allottedCapital)!.toLocaleString()}</span>
                            : '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Control
                            size="sm"
                            type="number"
                            value={editing[u.email].targetPoints}
                            onChange={e => updateEditingField(u.email, { targetPoints: e.target.value })}
                            style={{ width: 100 }}
                          />
                        ) : (
                          (u.targetPoints ?? userDefaults.targetPoints) != null
                            ? <span title={u.targetPoints == null ? 'global default' : undefined}>{u.targetPoints ?? userDefaults.targetPoints}</span>
                            : '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Control
                            size="sm"
                            type="number"
                            value={editing[u.email].stopLossPoints}
                            onChange={e => updateEditingField(u.email, { stopLossPoints: e.target.value })}
                            style={{ width: 100 }}
                          />
                        ) : (
                          (u.stopLossPoints ?? userDefaults.stopLossPoints) != null
                            ? <span title={u.stopLossPoints == null ? 'global default' : undefined}>{u.stopLossPoints ?? userDefaults.stopLossPoints}</span>
                            : '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Form.Check
                            type="switch"
                            id={`useGTT-${u.email}`}
                            title="Broker GTT bracket at entry vs. in-app target/SL monitoring"
                            checked={editing[u.email].useGTT}
                            onChange={e => updateEditingField(u.email, { useGTT: e.target.checked })}
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
                            <Button size="sm" variant="secondary" onClick={() => cancelEdit(u.email)}>Cancel</Button>
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

                {(() => {
                  const strategyDefs: { configKey: string; title: string; headerExtra?: React.ReactNode; renderFields: () => React.ReactNode }[] = [
                    {
                      configKey: 'buySellStrategy',
                      title: 'Buy-Sell Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Initial Quantity', ['buySellStrategy', 'initialQuantity'], config.buySellStrategy?.initialQuantity)}</Col>
                            <Col md={6}>{renderConfigField('Increment Quantity', ['buySellStrategy', 'incrementQuantity'], config.buySellStrategy?.incrementQuantity)}</Col>
                            <Col md={6}>{renderConfigField('Average Threshold', ['buySellStrategy', 'averageThreshold'], config.buySellStrategy?.averageThreshold)}</Col>
                            <Col md={6}>{renderConfigField('Target Price', ['buySellStrategy', 'targetPrice'], config.buySellStrategy?.targetPrice)}</Col>
                            <Col md={6}>{renderConfigField('Max Iteration Count', ['buySellStrategy', 'maxIterationCount'], config.buySellStrategy?.maxIterationCount)}</Col>
                            <Col md={6}>{renderConfigField('Right', ['buySellStrategy', 'right'], config.buySellStrategy?.right, 'text')}</Col>
                          </Row>
                          {renderConfigField('Stop Enabled', ['buySellStrategy', 'stopEnabled'], config.buySellStrategy?.stopEnabled, 'boolean')}
                          {renderConfigField('Log Enabled', ['buySellStrategy', 'logEnabled'], config.buySellStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'continuousStrategy',
                      title: 'Continuous Strategy',
                      headerExtra: (
                        <Button
                          size="sm"
                          variant="outline-danger"
                          onClick={e => { e.stopPropagation(); handleResetContinuousStrategy(); }}
                        >
                          Reset
                        </Button>
                      ),
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Initial Quantity', ['continuousStrategy', 'initialQuantity'], config.continuousStrategy?.initialQuantity)}</Col>
                            <Col md={6}>{renderConfigField('SL Distance', ['continuousStrategy', 'slDistance'], config.continuousStrategy?.slDistance)}</Col>
                            <Col md={6}>{renderConfigField('Square-off Distance', ['continuousStrategy', 'squareOffDistance'], config.continuousStrategy?.squareOffDistance)}</Col>
                            <Col md={6}>{renderConfigField('Minimum Premium', ['continuousStrategy', 'minPremium'], config.continuousStrategy?.minPremium)}</Col>
                            <Col md={6}>{renderConfigField('Max Investment', ['continuousStrategy', 'maxInvestment'], config.continuousStrategy?.maxInvestment)}</Col>
                            <Col md={6}>{renderConfigField('Spawn Quantity Mode', ['continuousStrategy', 'spawnQuantityMode'], config.continuousStrategy?.spawnQuantityMode)}</Col>
                            <Col md={6}>{renderConfigField('Max Profit %', ['continuousStrategy', 'maxProfit'], config.continuousStrategy?.maxProfit)}</Col>
                            <Col md={6}>{renderConfigField('Right', ['continuousStrategy', 'right'], config.continuousStrategy?.right, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Cooldown (sec)', ['continuousStrategy', 'cooldownSeconds'], config.continuousStrategy?.cooldownSeconds)}</Col>
                          </Row>
                          {renderConfigField('Log Enabled', ['continuousStrategy', 'logEnabled'], config.continuousStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'sentimentStrategy',
                      title: 'Sentiment Strategy',
                      renderFields: () => (
                        <Row>
                          <Col md={6}>{renderConfigField('Average Threshold', ['sentimentStrategy', 'averageThreshold'], config.sentimentStrategy?.averageThreshold)}</Col>
                          <Col md={6}>{renderConfigField('Target Price', ['sentimentStrategy', 'targetPrice'], config.sentimentStrategy?.targetPrice)}</Col>
                          <Col md={6}>{renderConfigField('Order Quantity', ['sentimentStrategy', 'orderQuantity'], config.sentimentStrategy?.orderQuantity)}</Col>
                          <Col md={6}>{renderConfigField('Sentiment', ['sentimentStrategy', 'sentiment'], config.sentimentStrategy?.sentiment, 'text')}</Col>
                          <Col md={6}>{renderConfigField('Loop Count', ['sentimentStrategy', 'loopCount'], config.sentimentStrategy?.loopCount)}</Col>
                        </Row>
                      ),
                    },
                    {
                      configKey: 'intermittentStrategy',
                      title: 'Intermittent Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Loop Count', ['intermittentStrategy', 'loopCount'], config.intermittentStrategy?.loopCount)}</Col>
                            <Col md={6}>{renderConfigField('Target Price', ['intermittentStrategy', 'targetPrice'], config.intermittentStrategy?.targetPrice)}</Col>
                            <Col md={6}>{renderConfigField('Quantity', ['intermittentStrategy', 'quantity'], config.intermittentStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('Threshold', ['intermittentStrategy', 'threshold'], config.intermittentStrategy?.threshold)}</Col>
                          </Row>
                          {renderConfigField('Log Enabled', ['intermittentStrategy', 'logEnabled'], config.intermittentStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'rateOfChangeStrategy',
                      title: 'Rate of Change Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Points Threshold', ['rateOfChangeStrategy', 'pointsThreshold'], config.rateOfChangeStrategy?.pointsThreshold)}</Col>
                            <Col md={6}>{renderConfigField('Acceleration Threshold', ['rateOfChangeStrategy', 'accelerationThreshold'], config.rateOfChangeStrategy?.accelerationThreshold)}</Col>
                            <Col md={6}>{renderConfigField('Quantity', ['rateOfChangeStrategy', 'quantity'], config.rateOfChangeStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('Data Points Window', ['rateOfChangeStrategy', 'numberOfDatapointsReceived'], config.rateOfChangeStrategy?.numberOfDatapointsReceived)}</Col>
                            <Col md={6}>{renderConfigField('Target Price', ['rateOfChangeStrategy', 'targetPrice'], config.rateOfChangeStrategy?.targetPrice)}</Col>
                            <Col md={6}>{renderConfigField('Stop Loss Price', ['rateOfChangeStrategy', 'stopLossPrice'], config.rateOfChangeStrategy?.stopLossPrice)}</Col>
                            <Col md={6}>{renderConfigField('Max Hold Time (min)', ['rateOfChangeStrategy', 'maxHoldTimeMinutes'], config.rateOfChangeStrategy?.maxHoldTimeMinutes)}</Col>
                          </Row>
                          {renderConfigField('Log Enabled', ['rateOfChangeStrategy', 'logEnabled'], config.rateOfChangeStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'gapStrategy',
                      title: 'Gap Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Points Threshold', ['gapStrategy', 'pointsThreshold'], config.gapStrategy?.pointsThreshold)}</Col>
                            <Col md={6}>{renderConfigField('Data Points Window', ['gapStrategy', 'numberOfDatapointsReceived'], config.gapStrategy?.numberOfDatapointsReceived)}</Col>
                            <Col md={6}>{renderConfigField('Quantity', ['gapStrategy', 'quantity'], config.gapStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('Target Price', ['gapStrategy', 'targetPrice'], config.gapStrategy?.targetPrice)}</Col>
                            <Col md={6}>{renderConfigField('Stop Loss Price', ['gapStrategy', 'stopLossPrice'], config.gapStrategy?.stopLossPrice)}</Col>
                            <Col md={6}>{renderConfigField('Max Hold Time (min)', ['gapStrategy', 'maxHoldTimeMinutes'], config.gapStrategy?.maxHoldTimeMinutes)}</Col>
                            <Col md={6}>{renderConfigField('Gap Reversal Threshold', ['gapStrategy', 'gapReversalThreshold'], config.gapStrategy?.gapReversalThreshold)}</Col>
                          </Row>
                          {renderConfigField('Gap Reversal Mode', ['gapStrategy', 'gapReversalMode'], config.gapStrategy?.gapReversalMode, 'boolean')}
                          {renderConfigField('Log Enabled', ['gapStrategy', 'logEnabled'], config.gapStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'goodMorningStrategy',
                      title: 'Good Morning Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Quantity', ['goodMorningStrategy', 'quantity'], config.goodMorningStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('Target Points', ['goodMorningStrategy', 'targetPoints'], config.goodMorningStrategy?.targetPoints)}</Col>
                            <Col md={6}>{renderConfigField('Stop Loss Points', ['goodMorningStrategy', 'stopLossPoints'], config.goodMorningStrategy?.stopLossPoints)}</Col>
                            <Col md={6}>{renderConfigField('Previous Close', ['goodMorningStrategy', 'previousClose'], config.goodMorningStrategy?.previousClose)}</Col>
                            <Col md={6}>{renderConfigField('Snapshot Time', ['goodMorningStrategy', 'snapshotTime'], config.goodMorningStrategy?.snapshotTime, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Confirm Time', ['goodMorningStrategy', 'confirmTime'], config.goodMorningStrategy?.confirmTime, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Min Movement Points', ['goodMorningStrategy', 'minMovementPoints'], config.goodMorningStrategy?.minMovementPoints)}</Col>
                          </Row>
                          {renderConfigField('Log Enabled', ['goodMorningStrategy', 'logEnabled'], config.goodMorningStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'goodMorningSensexStrategy',
                      title: 'Good Morning Sensex Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Quantity', ['goodMorningSensexStrategy', 'quantity'], config.goodMorningSensexStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('Target Points', ['goodMorningSensexStrategy', 'targetPoints'], config.goodMorningSensexStrategy?.targetPoints)}</Col>
                            <Col md={6}>{renderConfigField('Stop Loss Points', ['goodMorningSensexStrategy', 'stopLossPoints'], config.goodMorningSensexStrategy?.stopLossPoints)}</Col>
                            <Col md={6}>{renderConfigField('Previous Close', ['goodMorningSensexStrategy', 'previousClose'], config.goodMorningSensexStrategy?.previousClose)}</Col>
                            <Col md={6}>{renderConfigField('Snapshot Time', ['goodMorningSensexStrategy', 'snapshotTime'], config.goodMorningSensexStrategy?.snapshotTime, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Confirm Time', ['goodMorningSensexStrategy', 'confirmTime'], config.goodMorningSensexStrategy?.confirmTime, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Min Movement Points', ['goodMorningSensexStrategy', 'minMovementPoints'], config.goodMorningSensexStrategy?.minMovementPoints)}</Col>
                          </Row>
                          {renderConfigField('Log Enabled', ['goodMorningSensexStrategy', 'logEnabled'], config.goodMorningSensexStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'supportResistanceStrategy',
                      title: 'Support/Resistance Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Quantity', ['supportResistanceStrategy', 'quantity'], config.supportResistanceStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('SL Distance', ['supportResistanceStrategy', 'slDistance'], config.supportResistanceStrategy?.slDistance)}</Col>
                            <Col md={6}>{renderConfigField('Square-off Distance', ['supportResistanceStrategy', 'squareOffDistance'], config.supportResistanceStrategy?.squareOffDistance)}</Col>
                            <Col md={6}>{renderConfigField('Max Levels', ['supportResistanceStrategy', 'maxLevels'], config.supportResistanceStrategy?.maxLevels)}</Col>
                            <Col md={6}>{renderConfigField('Minimum Premium', ['supportResistanceStrategy', 'minPremium'], config.supportResistanceStrategy?.minPremium)}</Col>
                            <Col md={6}>{renderConfigField('Max Investment', ['supportResistanceStrategy', 'maxInvestment'], config.supportResistanceStrategy?.maxInvestment)}</Col>
                            <Col md={6}>{renderConfigField('Max Profit %', ['supportResistanceStrategy', 'maxProfit'], config.supportResistanceStrategy?.maxProfit)}</Col>
                            <Col md={6}>{renderConfigField('Spawn Quantity Mode', ['supportResistanceStrategy', 'spawnQuantityMode'], config.supportResistanceStrategy?.spawnQuantityMode)}</Col>
                            <Col md={6}>{renderConfigField('Cooldown (sec)', ['supportResistanceStrategy', 'cooldownSeconds'], config.supportResistanceStrategy?.cooldownSeconds)}</Col>
                          </Row>
                          {renderConfigField('Log Enabled', ['supportResistanceStrategy', 'logEnabled'], config.supportResistanceStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'targetReachStrategy',
                      title: 'Target Reach Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Symbol', ['targetReachStrategy', 'symbol'], config.targetReachStrategy?.symbol, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Strike', ['targetReachStrategy', 'strike'], config.targetReachStrategy?.strike)}</Col>
                            <Col md={6}>{renderConfigField('Expiry', ['targetReachStrategy', 'expiry'], config.targetReachStrategy?.expiry, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Option Type', ['targetReachStrategy', 'optionType'], config.targetReachStrategy?.optionType, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Target Price', ['targetReachStrategy', 'targetPrice'], config.targetReachStrategy?.targetPrice)}</Col>
                            <Col md={6}>{renderConfigField('Quantity', ['targetReachStrategy', 'quantity'], config.targetReachStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('Target Points', ['targetReachStrategy', 'targetPoints'], config.targetReachStrategy?.targetPoints)}</Col>
                            <Col md={6}>{renderConfigField('Stop Loss Points', ['targetReachStrategy', 'stopLossPoints'], config.targetReachStrategy?.stopLossPoints)}</Col>
                          </Row>
                          {renderConfigField('Log Enabled', ['targetReachStrategy', 'logEnabled'], config.targetReachStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                    {
                      configKey: 'ruleBasedStrategy',
                      title: 'Rule Based Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>{renderConfigField('Quantity', ['ruleBasedStrategy', 'quantity'], config.ruleBasedStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('Target', ['ruleBasedStrategy', 'target'], config.ruleBasedStrategy?.target)}</Col>
                            <Col md={6}>{renderConfigField('Stop Loss', ['ruleBasedStrategy', 'stopLoss'], config.ruleBasedStrategy?.stopLoss)}</Col>
                            <Col md={6}>{renderConfigField('Max Hold Time (min)', ['ruleBasedStrategy', 'maxHoldTimeMinutes'], config.ruleBasedStrategy?.maxHoldTimeMinutes)}</Col>
                          </Row>
                          <Form.Group className="mb-3">
                            <Form.Label>{fieldLabel('Indicators (JSON)', ['ruleBasedStrategy', 'indicators'])}</Form.Label>
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
                        </>
                      ),
                    },
                    {
                      configKey: 'bulkPcrStrategy',
                      title: 'Bulk PCR Strategy',
                      renderFields: () => (
                        <>
                          <Row>
                            <Col md={6}>
                              <Form.Group className="mb-3">
                                <Form.Label>{fieldLabel('Brokers', ['bulkPcrStrategy', 'brokers'])}</Form.Label>
                                {(['zerodha', 'breeze'] as const).map(broker => (
                                  <Form.Check
                                    key={broker}
                                    type="checkbox"
                                    label={broker === 'zerodha' ? 'Zerodha' : 'Breeze'}
                                    checked={(config.bulkPcrStrategy?.brokers ?? []).includes(broker)}
                                    onChange={e => {
                                      const current: string[] = config.bulkPcrStrategy?.brokers ?? [];
                                      const next = e.target.checked ? [...current, broker] : current.filter((b: string) => b !== broker);
                                      updateConfigValue(['bulkPcrStrategy', 'brokers'], next);
                                    }}
                                  />
                                ))}
                              </Form.Group>
                            </Col>
                            <Col md={6}>{renderConfigField('Quantity', ['bulkPcrStrategy', 'quantity'], config.bulkPcrStrategy?.quantity)}</Col>
                            <Col md={6}>{renderConfigField('Target Points', ['bulkPcrStrategy', 'targetPoints'], config.bulkPcrStrategy?.targetPoints)}</Col>
                            <Col md={6}>{renderConfigField('Right', ['bulkPcrStrategy', 'right'], config.bulkPcrStrategy?.right, 'text')}</Col>
                            <Col md={6}>{renderConfigField('Max Investment', ['bulkPcrStrategy', 'maxInvestment'], config.bulkPcrStrategy?.maxInvestment)}</Col>
                          </Row>
                          {renderConfigField('Log Enabled', ['bulkPcrStrategy', 'logEnabled'], config.bulkPcrStrategy?.logEnabled, 'boolean')}
                        </>
                      ),
                    },
                  ];

                  const enabledDefs = strategyDefs.filter(d => config[d.configKey]?.enabled);
                  const disabledDefs = strategyDefs.filter(d => !config[d.configKey]?.enabled);

                  const renderAccordionItem = (def: typeof strategyDefs[number]) => {
                    const pnl = STRATEGY_PNL_USER[def.configKey] ? strategyPnl[def.configKey] : undefined;
                    return (
                      <Accordion.Item eventKey={def.configKey} key={def.configKey}>
                        <Accordion.Header>
                          <div className="d-flex align-items-center justify-content-between flex-grow-1 me-3">
                            <span className="fw-semibold">{def.title}</span>
                            <div className="d-flex align-items-center gap-3">
                              {pnl && (
                                <div className="d-flex gap-3 small">
                                  <span className={pnl.realized >= 0 ? 'text-success' : 'text-danger'}>
                                    Realized: {pnl.realized >= 0 ? '+' : ''}₹{pnl.realized.toFixed(2)}
                                  </span>
                                  <span className={pnl.unrealized >= 0 ? 'text-success' : 'text-danger'}>
                                    Unrealized: {pnl.unrealized >= 0 ? '+' : ''}₹{pnl.unrealized.toFixed(2)}
                                  </span>
                                </div>
                              )}
                              {def.headerExtra}
                              <div onClick={e => e.stopPropagation()}>
                                <Form.Check
                                  type="switch"
                                  label="Enabled"
                                  checked={!!config[def.configKey]?.enabled}
                                  onChange={e => updateConfigValue([def.configKey, 'enabled'], e.target.checked)}
                                />
                              </div>
                            </div>
                          </div>
                        </Accordion.Header>
                        <Accordion.Body>{def.renderFields()}</Accordion.Body>
                      </Accordion.Item>
                    );
                  };

                  return (
                    <>
                      <Card className="mb-3">
                        <Card.Header className="fw-bold">Enabled Strategies</Card.Header>
                        <Card.Body>
                          {enabledDefs.length === 0 ? (
                            <p className="text-muted mb-0">No strategies are currently enabled.</p>
                          ) : (
                            <Accordion alwaysOpen>{enabledDefs.map(renderAccordionItem)}</Accordion>
                          )}
                        </Card.Body>
                      </Card>

                      <Card className="mb-3">
                        <Card.Header className="fw-bold">Disabled Strategies</Card.Header>
                        <Card.Body>
                          {disabledDefs.length === 0 ? (
                            <p className="text-muted mb-0">No strategies are currently disabled.</p>
                          ) : (
                            <Accordion alwaysOpen>{disabledDefs.map(renderAccordionItem)}</Accordion>
                          )}
                        </Card.Body>
                      </Card>
                    </>
                  );
                })()}

                <div className="d-flex align-items-center gap-2">
                  <Button variant="primary" onClick={saveConfig}>Save Now</Button>
                  <Button variant="secondary" onClick={fetchConfig}>Reset</Button>
                  <span className="text-muted small">Changes auto-save a moment after you stop typing.</span>
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
                  <Col md={6}>
                    <DateRangeFilter value={payoutPeriod} onChange={setPayoutPeriod} size="sm" />
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

          <Tab eventKey="trades" title="Trades">
            <Card className="mb-3">
              <Card.Header className="fw-bold">Filter</Card.Header>
              <Card.Body>
                <Row className="g-2 align-items-end mb-3">
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label className="small">User</Form.Label>
                      <Form.Select size="sm" value={tradeUser} onChange={e => setTradeUser(e.target.value)}>
                        <option value="__all__">All Users</option>
                        <optgroup label="Users">
                          {users.map(u => <option key={u.email} value={u.email}>{u.name} ({u.email})</option>)}
                        </optgroup>
                        <optgroup label="Strategies">
                          {strategies.map(s => <option key={s.userId} value={s.userId}>{s.type}</option>)}
                        </optgroup>
                      </Form.Select>
                    </Form.Group>
                  </Col>
                  <Col md={8}>
                    <DateRangeFilter value={tradeDateRange} onChange={setTradeDateRange} size="sm" modes={['day', 'week', 'month']} />
                  </Col>
                </Row>
                <div className="d-flex align-items-center gap-2">
                  <small className="text-muted">{formatRangeLabel(tradeDateRange)}</small>
                  {tradesLoading && <Spinner animation="border" size="sm" />}
                </div>
                {tradesError && <Alert variant="danger" dismissible onClose={() => setTradesError(null)} className="mt-2">{tradesError}</Alert>}
              </Card.Body>
            </Card>

            <Button variant="outline-primary" size="sm" className="mb-3" onClick={() => setShowStatusModal(v => !v)}>
              {showStatusModal ? 'Hide Status' : 'View Status'}
            </Button>

            <Card className="mb-3">
              <Card.Header className="fw-bold">P&amp;L Summary</Card.Header>
              <Card.Body>
                {tradeUser === '__all__' ? (
                  <>
                    <div className="fs-4 fw-bold">
                      &#8377;{closedTradesList.reduce((s, t) => s + (t.realizedPnL || 0), 0).toFixed(2)}
                    </div>
                    <small className="text-muted">Select a single user to see eligible P&amp;L (excluding any forfeited profit).</small>
                  </>
                ) : tradeDateRange.mode === 'day' ? (
                  <div className="fs-4 fw-bold">
                    &#8377;{closedTradesList.reduce((s, t) => s + (t.realizedPnL || 0), 0).toFixed(2)}
                  </div>
                ) : !pnlSummary ? (
                  <Spinner animation="border" size="sm" />
                ) : tradeDateRange.mode === 'week' ? (
                  <>
                    <div className="fs-4 fw-bold">&#8377;{pnlSummary.eligibleTotal.toFixed(2)}</div>
                    {pnlSummary.rawTotal !== pnlSummary.eligibleTotal && (
                      <small className="text-muted d-block">Raw P&amp;L: &#8377;{pnlSummary.rawTotal.toFixed(2)}</small>
                    )}
                    {pnlSummary.forfeited && (
                      <Alert variant="warning" className="mt-2 mb-0">{pnlSummary.forfeitReason}</Alert>
                    )}
                  </>
                ) : (
                  <>
                    <div className="fs-4 fw-bold mb-3">&#8377;{pnlSummary.eligibleTotal.toFixed(2)}</div>
                    <Table size="sm" striped responsive className="mb-0">
                      <thead>
                        <tr><th>Week</th><th>Raw P&amp;L</th><th>Eligible P&amp;L</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {(pnlSummary.weeks || []).map((w: any, i: number) => (
                          <tr key={i}>
                            <td>{w.weekStart} – {w.weekEnd}</td>
                            <td>&#8377;{w.rawPnL.toFixed(2)}</td>
                            <td>&#8377;{w.eligiblePnL.toFixed(2)}</td>
                            <td>{w.forfeited ? <span className="text-danger" title={w.forfeitReason}>Forfeited</span> : <span className="text-success">OK</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </>
                )}
              </Card.Body>
            </Card>

            <Modal show={showStatusModal} onHide={() => setShowStatusModal(false)} centered>
              <Modal.Header closeButton>
                <Modal.Title>Status</Modal.Title>
              </Modal.Header>
              <Modal.Body>
                {(() => {
                  const realizedPnL = closedTradesList.reduce((s, t) => s + (t.realizedPnL || 0), 0);
                  const unrealizedPnL = openTradesList.reduce((s, t) => s + ((t.lastTradePrice - t.price) * t.quantity || 0), 0);
                  const realizedColor = realizedPnL >= 0 ? 'text-success' : 'text-danger';
                  const unrealizedColor = unrealizedPnL >= 0 ? 'text-success' : 'text-danger';
                  return (
                    <>
                      <Row className="mb-3 text-center">
                        <Col>
                          <div className="small text-muted">Realized PnL</div>
                          <div className={`fs-5 fw-bold ${realizedColor}`}>
                            {realizedPnL >= 0 ? '+' : ''}&#8377;{realizedPnL.toFixed(2)}
                          </div>
                        </Col>
                        <Col>
                          <div className="small text-muted">Unrealized PnL</div>
                          <div className={`fs-5 fw-bold ${unrealizedColor}`}>
                            {unrealizedPnL >= 0 ? '+' : ''}&#8377;{unrealizedPnL.toFixed(2)}
                          </div>
                        </Col>
                      </Row>
                      {openTradesList.length === 0 ? (
                        <p className="text-center text-muted py-3 mb-0">No open positions.</p>
                      ) : (
                        <Table striped hover responsive size="sm" className="mb-0">
                          <thead>
                            <tr><th>Contract</th><th>Qty</th><th>PnL</th></tr>
                          </thead>
                          <tbody>
                            {openTradesList.map((t, i) => {
                              const pnl = (t.lastTradePrice - t.price) * t.quantity || 0;
                              const pnlColor = pnl >= 0 ? 'text-success' : 'text-danger';
                              return (
                                <tr key={t._id || i}>
                                  <td>{t.tsym}</td>
                                  <td>{t.quantity}</td>
                                  <td className={`fw-bold ${pnlColor}`}>{pnl >= 0 ? '+' : ''}&#8377;{pnl.toFixed(2)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </Table>
                      )}
                    </>
                  );
                })()}
              </Modal.Body>
            </Modal>
          </Tab>
        </Tabs>
      </Container>
    </div>
  );
}
