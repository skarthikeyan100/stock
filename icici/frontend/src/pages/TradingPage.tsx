import { useState } from 'react';
import { Container, Alert, Tab, Tabs, Badge, Button } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { useTrading } from '../context/TradingContext';
import { useAuth } from '../context/AuthContext';
import OrderEntry from '../components/OrderEntry';
import NiftyTicker from '../components/NiftyTicker';
import PositionCard from '../components/PositionCard';
import NotificationBell from '../components/NotificationBell';

export default function TradingPage() {
  const { trades, closedTrades, openPnL, totalPnL, usedAmount } = useTrading();
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const maxLoss = user?.lossLimit ?? 15000;
  const investmentAmount = user?.investmentAmount ?? 100000;
  const availableAmount = investmentAmount - usedAmount;
  const [activeTab, setActiveTab] = useState('active');

  const totalColor = totalPnL >= 0 ? 'success' : 'danger';
  const openColor = openPnL >= 0 ? 'success' : 'danger';
  const nearLimit = totalPnL < 0 && Math.abs(totalPnL) >= maxLoss * 0.8;

  return (
    <div className="trading-bg min-vh-100">
      {/* P&L Header */}
      <div className={`pnl-bar bg-${totalColor} bg-opacity-10 border-bottom`}>
        <Container className="py-2 d-flex justify-content-between align-items-center" style={{ position: 'relative' }}>
          <div className="d-flex align-items-center gap-2">
            <div
              className="d-flex align-items-center gap-2"
              role="button"
              style={{ cursor: 'pointer' }}
              onClick={() => navigate('/app/profile')}
              title="View profile"
            >
              {user?.picture && <img src={user.picture} alt="" width={28} height={28} className="rounded-circle" />}
              <span className="fw-bold">{user?.name || 'PropFirm Trading'}</span>
            </div>
            <NotificationBell />
            <Button variant="outline-secondary" size="sm" onClick={() => navigate('/app/profile')}>Profile</Button>
            {isAdmin && (
              <Button variant="outline-primary" size="sm" onClick={() => navigate('/app/admin')}>Admin</Button>
            )}
            <Button variant="outline-secondary" size="sm" onClick={logout}>Logout</Button>
          </div>
          <div className={`text-center text-${openColor}`} style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>
            <div className="small">Current P&amp;L</div>
            <span className={`fw-bold fs-5`}>{openPnL >= 0 ? '+' : ''}&#8377;{openPnL.toFixed(2)}</span>
          </div>
          <div className="text-end">
            <div className="small text-muted">Total P&amp;L</div>
            <span className={`fw-bold fs-5 text-${totalColor}`}>
              {totalPnL >= 0 ? '+' : ''}&#8377;{totalPnL.toFixed(2)}
            </span>
          </div>
        </Container>
      </div>

      {/* Available / Used bar */}
      <div className="border-bottom bg-light">
        <Container className="py-1 d-flex justify-content-center gap-4">
          <small>
            <span className="text-muted">Available: </span>
            <span className={`fw-bold ${availableAmount >= 0 ? 'text-success' : 'text-danger'}`}>
              &#8377;{availableAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </small>
          <small>
            <span className="text-muted">Used: </span>
            <span className="fw-bold">&#8377;{usedAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </small>
        </Container>
      </div>

      {/* NIFTY live price ticker */}
      <NiftyTicker />

      {nearLimit && (
        <Alert variant="warning" className="mb-0 rounded-0 text-center">
          Warning: Approaching maximum loss limit of &#8377;{maxLoss.toLocaleString()}
        </Alert>
      )}

      <Container className="py-4" style={{ maxWidth: 700 }}>
        {/* Order Entry */}
        <h6 className="text-muted mb-2">Place Order</h6>
        <OrderEntry />

        {/* Positions Tabs */}
        <div className="mt-4">
          <Tabs
            activeKey={activeTab}
            onSelect={(k) => setActiveTab(k || 'active')}
            className="mb-3"
          >
            <Tab
              eventKey="active"
              title={
                <span>
                  Active Positions{' '}
                  {trades.length > 0 && <Badge bg="primary">{trades.length}</Badge>}
                </span>
              }
            >
              {trades.length > 0 ? (
                trades.map((trade) => (
                  <PositionCard key={trade.tsym} trade={trade} />
                ))
              ) : (
                <div className="text-center text-muted py-4">
                  <p className="mb-1">No active positions</p>
                  <small>Place an order using the buttons above</small>
                </div>
              )}
            </Tab>
            <Tab
              eventKey="closed"
              title={
                <span>
                  Closed Trades{' '}
                  {closedTrades.length > 0 && <Badge bg="secondary">{closedTrades.length}</Badge>}
                </span>
              }
            >
              {closedTrades.length > 0 ? (
                closedTrades.map((trade, i) => (
                  <PositionCard key={`${trade.tsym}-closed-${i}`} trade={trade} closed />
                ))
              ) : (
                <div className="text-center text-muted py-4">
                  <p className="mb-0">No closed trades yet</p>
                </div>
              )}
            </Tab>
          </Tabs>
        </div>
      </Container>
    </div>
  );
}
