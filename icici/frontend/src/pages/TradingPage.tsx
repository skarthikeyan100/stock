import { useState } from 'react';
import { Container, Alert, Tab, Tabs, Badge, Button } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { useTrading } from '../context/TradingContext';
import { useAuth } from '../context/AuthContext';
import OrderEntry from '../components/OrderEntry';
import TradingFaq from '../components/TradingFaq';
import NiftyTicker from '../components/NiftyTicker';
import PositionCard from '../components/PositionCard';
import NotificationBell from '../components/NotificationBell';
import ThemeToggle from '../components/ThemeToggle';
import OrderNotices from '../components/OrderNotices';
import PendingBuyCard from '../components/PendingBuyCard';
import { useMarketHours } from '../utils/marketHours';

export default function TradingPage() {
  const { trades, closedTrades, openPnL, totalPnL, usedAmount, tradingBlocked, blockReason, index, setIndex, orderMode, locked } = useTrading();
  const marketOpen = useMarketHours();
  const { user, logout, isAdmin } = useAuth();
  const handleLogout = async () => {
    if (!(await logout())) window.alert('Logout could not be completed - please try again.');
  };
  const navigate = useNavigate();
  const maxLoss = user?.lossLimit ?? 15000;
  const investmentAmount = user?.accountCapital ?? user?.investmentAmount ?? 100000;
  const availableAmount = investmentAmount - usedAmount;
  const [activeTab, setActiveTab] = useState('active');
  // Search & Buy is an Advanced feature (the server refuses a Beginner's contract order too); admins see everything.
  const canSearch = isAdmin || user?.proficiencyLevel === 'advanced';
  // Buys still waiting to fill are listed with the active positions (a pending sell is shown on its position's card).
  const pendingBuys = locked ? locked.pending.filter((o) => o.action === 'Buy') : [];
  const activeCount = trades.length + pendingBuys.length;
  const severalBrokers = new Set([...trades.map((t) => t.broker), ...pendingBuys.map((o) => o.broker)].filter(Boolean)).size > 1;

  const totalColor = totalPnL >= 0 ? 'success' : 'danger';
  const openColor = openPnL >= 0 ? 'success' : 'danger';
  const nearLimit = totalPnL < 0 && Math.abs(totalPnL) >= maxLoss * 0.8;

  return (
    <div className="trading-bg min-vh-100">
      <div className="trading-header-sticky">
        {/* P&L Header */}
        <div className={`pnl-bar bg-${totalColor} bg-opacity-10 border-bottom`}>
          <Container className="py-2 d-flex justify-content-between align-items-center" style={{ position: 'relative' }}>
            <div className="d-flex align-items-center gap-2">
              <div
                className="d-flex align-items-center gap-2"
                role="button"
                style={{ cursor: 'pointer' }}
                onClick={() => navigate('/profile')}
                title="View profile"
              >
                {user?.picture && <img src={user.picture} alt="" width={28} height={28} className="rounded-circle" />}
                <span className="fw-bold">{user?.name || 'PropFirm Trading'}</span>
              </div>
              <ThemeToggle />
              <TradingFaq />
              <NotificationBell />
              <Button variant="outline-secondary" size="sm" onClick={() => navigate('/profile')}>Profile</Button>
              {isAdmin && (
                <Button variant="outline-primary" size="sm" onClick={() => navigate('/admin')}>Admin</Button>
              )}
              <Button variant="outline-secondary" size="sm" onClick={handleLogout}>Logout</Button>
            </div>
            <div className={`pnl-center text-center text-${openColor}`}>
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
        <div className="border-bottom bg-body-tertiary">
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

        {/* Index live price, with the NIFTY / SENSEX switch (needs the server's SENSEX stream) */}
        <NiftyTicker index={index} onSelect={orderMode === 'locked' ? setIndex : undefined} />
      </div>

      {nearLimit && (
        <Alert variant="warning" className="mb-0 rounded-0 text-center">
          Warning: Approaching maximum loss limit of &#8377;{maxLoss.toLocaleString()}
        </Alert>
      )}

      <Container className="py-4" style={{ maxWidth: 700 }}>
        {/* Order Entry */}
        {tradingBlocked ? (
          <Alert variant="danger" className="text-center mb-4">
            <strong>Trading disabled.</strong> {blockReason || 'You have breached a trading rule.'}
          </Alert>
        ) : (
          <>
            {!marketOpen && (
              <Alert variant="info" className="text-center py-2 mb-3">
                <strong>Market is closed.</strong> Orders can be placed only on trading days, Monday to Friday, 9:15 AM to 3:30 PM IST.
              </Alert>
            )}
            <h6 className="text-muted mb-2">Place Order</h6>
            <OrderEntry part="flash" />
          </>
        )}

        <OrderNotices />

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
                  {activeCount > 0 && <Badge bg="primary">{activeCount}</Badge>}
                </span>
              }
            >
              {pendingBuys.map((o) => (
                <PendingBuyCard key={`${o.broker}:${o.orderId}`} order={o} showBroker={severalBrokers} />
              ))}
              {trades.map((trade) => (
                <PositionCard key={`${trade.token}|${(trade as any).broker ?? ''}|${trade.user ?? ''}`} trade={trade} /> /* a position is token + broker (+ user): an index key moved unsent target/stop text to another row */
              ))}
              {activeCount === 0 && (
                <div className="text-center text-muted py-4">
                  <p className="mb-1">No active positions</p>
                  <small>Place an order using Flash Trade or Search & Buy</small>
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
                  <PositionCard key={`${trade.token}-closed-${i}`} trade={trade} closed />
                ))
              ) : (
                <div className="text-center text-muted py-4">
                  <p className="mb-0">No closed trades yet</p>
                </div>
              )}
            </Tab>
          </Tabs>
        </div>

        {/* Search & Buy sits below the positions */}
        {!tradingBlocked && canSearch && (
          <div className="mt-4">
            <OrderEntry part="search" />
          </div>
        )}
        {!tradingBlocked && !canSearch && (
          <div className="mt-4 p-3 border rounded text-center text-muted small">
            <strong>Search &amp; Buy</strong> (pick any strike and expiry) is available at the Advanced level.{' '}
            <a href="/profile#upgrade">Request Advanced</a>.
          </div>
        )}
      </Container>
    </div>
  );
}
