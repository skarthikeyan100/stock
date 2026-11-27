import { useState } from 'react';
import { Card, Button, Badge, Row, Col, Form, InputGroup } from 'react-bootstrap';
import { useTrading, Trade } from '../context/TradingContext';
import { useAuth } from '../context/AuthContext';
import DemoHelpTip from './DemoHelpTip';
import { optionRight } from '../utils/optionRight';

// `demo`: the anonymous demo page renders this same card (its provider supplies the same trading context), with help bubbles on the
// target/stop-loss controls and the pending-points hint while a fill waits for a price.
export default function PositionCard({ trade, closed, demo }: { trade: Trade; closed?: boolean; demo?: boolean }) {
  const { squareOff, setTargetStopLoss, trades, locked, orderMode } = useTrading();
  const { isAdmin } = useAuth();
  // Broker tags are for admins only. On an open position: only when the same contract is open on more than one broker (each row is its own position).
  const onSeveralBrokers = !closed && !!trade.broker && trades.some((o) => o.token === trade.token && o.broker !== trade.broker);
  const [targetPoints, setTargetPoints] = useState('');
  const [slPoints, setSlPoints] = useState('');

  const pnl = closed
    ? (trade.realizedPnL || 0)
    : trade.lastTradePrice ? (trade.lastTradePrice - trade.price) * trade.quantity : 0;
  const pnlColor = pnl >= 0 ? 'text-success' : 'text-danger';
  const rightLabel = optionRight(trade);

  const hasTarget = !!trade.targetPrice;
  const hasStopLoss = !!trade.stopLossPrice;
  const hasTargetSet = hasTarget && hasStopLoss;
  const [busy, setBusy] = useState(false);
  // The inputs are open while nothing is set yet, or after "Edit".
  const [editing, setEditing] = useState(false);
  const showInputs = editing || (!hasTarget && !hasStopLoss);

  // Prefilled with the current distance from the average price; a level on the other side of it is left empty (and stays unless replaced).
  const asPoints = (points: number) => (points > 0 ? String(Math.round(points * 100) / 100) : '');
  const startEditing = () => {
    setTargetPoints(hasTarget ? asPoints(trade.targetPrice! - trade.price) : '');
    setSlPoints(hasStopLoss ? asPoints(trade.price - trade.stopLossPrice!) : '');
    setEditing(true);
  };
  const stopEditing = () => {
    setTargetPoints('');
    setSlPoints('');
    setEditing(false);
  };

  // Only the side(s) the user filled in are sent (0 = leave as it is); inputs are closed only if the server accepted it.
  const handleSetTargetSL = async () => {
    if (busy) return;
    const tp = targetPoints ? parseFloat(targetPoints) : 0;
    const sl = slPoints ? parseFloat(slPoints) : 0;
    if (!(Number.isFinite(tp) && tp >= 0) || !(Number.isFinite(sl) && sl >= 0) || (tp <= 0 && sl <= 0)) return;
    setBusy(true);
    try {
      const ok = await setTargetStopLoss(trade.token, tp, sl, trade.broker);
      if (ok) stopEditing();
    } finally {
      setBusy(false);
    }
  };

  const broker = trade.broker ?? 'kite';
  // This position's pending limit sell(s), and the live price a limit square-off would be placed at.
  const resting = !closed && locked ? locked.pending.filter((o) => o.action === 'Sell' && o.broker === broker && o.token === String(trade.token) && o.tsym === trade.tsym) : [];
  const canLimit = !!locked && ['kite', 'ant', 'breeze'].includes(broker);
  const sellPrice = !closed && canLimit ? locked!.positionPrice(trade) : null;

  // A limit sell at the live price, which is not shown. There is no selling at market: without a price to use, the button is disabled.
  // (The demo has no order service: its square-off is simulated.)
  const canSquareOff = orderMode ? sellPrice !== null : !!squareOff;
  const handleSquareOff = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!orderMode) await squareOff?.(trade.token, trade.quantity, trade.broker);
      else if (locked && sellPrice !== null) await locked.squareOffAt(trade, sellPrice);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelSell = async () => {
    if (busy || !locked) return;
    setBusy(true);
    try {
      await Promise.all(resting.filter((o) => !o.unconfirmed).map((o) => locked.cancelOrder(o)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={`mb-3 shadow-sm ${closed ? 'opacity-75' : ''}`}>
      <Card.Body>
        <Row className="align-items-center">
          <Col>
            <h5 className="mb-1">
              {trade.tsym}
              {rightLabel && (
                <Badge bg={rightLabel === 'CE' ? 'primary' : 'warning'} className="ms-2">
                  {rightLabel}
                </Badge>
              )}
              {isAdmin && (onSeveralBrokers || (closed && trade.broker)) && (
                <Badge bg="dark" className="ms-2 text-uppercase">{trade.broker}</Badge>
              )}
              {closed && (
                <Badge bg="secondary" className="ms-2">Closed</Badge>
              )}
              {resting.length > 0 && (
                <Badge bg="warning" text="dark" className="ms-2">Pending</Badge>
              )}
            </h5>
            <small className="text-muted">
              Qty: {trade.quantity} &middot; Avg: &#8377;{trade.price?.toFixed(2)}
            </small>
          </Col>

          <Col xs="auto" className="text-end">
            {closed ? (
              <div className={`fw-bold fs-5 ${pnlColor}`}>
                {pnl >= 0 ? '+' : ''}&#8377;{pnl.toFixed(2)}
              </div>
            ) : trade.lastTradePrice ? (
              <>
                <div className="mb-1">
                  <small className="text-muted">LTP </small>
                  <span className="fw-bold">&#8377;{trade.lastTradePrice?.toFixed(2)}</span>
                </div>
                <div className={`fw-bold fs-5 ${pnlColor}`}>
                  {pnl >= 0 ? '+' : ''}&#8377;{pnl.toFixed(2)}
                </div>
              </>
            ) : (
              <small className="text-muted">
                Waiting for price...
                {demo && (trade.pendingTargetPoints || trade.pendingStopLossPoints) && (
                  <>
                    <br />
                    Will apply {trade.pendingTargetPoints ? `Target +${trade.pendingTargetPoints}pts` : ''}
                    {trade.pendingTargetPoints && trade.pendingStopLossPoints ? ' / ' : ''}
                    {trade.pendingStopLossPoints ? `SL -${trade.pendingStopLossPoints}pts` : ''} on fill
                  </>
                )}
              </small>
            )}
          </Col>

          {!closed && (
            <Col xs="auto" className="text-end">
              {resting.length > 0 ? (
                <Button variant="outline-secondary" disabled={busy || resting.every((o) => o.unconfirmed)} onClick={handleCancelSell}>
                  Cancel
                </Button>
              ) : (
                <Button variant="outline-danger" disabled={busy || !canSquareOff} onClick={handleSquareOff}>
                  Square off
                </Button>
              )}
            </Col>
          )}
        </Row>

        {/* Target Price & Stop Loss */}
        {!closed && (
          <div className="mt-2 pt-2 border-top">
            {(hasTarget || hasStopLoss) && (
              <div className="d-flex align-items-center gap-2 mb-1">
                <small className="text-muted">
                  Target: <span className="fw-bold text-success">{hasTarget ? <>&#8377;{trade.targetPrice?.toFixed(2)}</> : 'not set'}</span>
                  {' '}&middot;{' '}
                  Stop Loss: <span className="fw-bold text-danger">{hasStopLoss ? <>&#8377;{trade.stopLossPrice?.toFixed(2)}</> : 'not set'}</span>
                  {demo && hasTargetSet && <DemoHelpTip text="The position auto-squares-off the moment a live price reaches the Target or Stop Loss level - no action needed from you." />}
                </small>
                {!showInputs && (
                  <Button variant="outline-primary" size="sm" className="ms-auto" onClick={startEditing}>
                    Edit
                  </Button>
                )}
              </div>
            )}
            {showInputs && (
              <div className="d-flex align-items-center gap-2 flex-wrap">
                {demo && <DemoHelpTip text="Optional: set a target and/or stop-loss in points from your entry price. The position auto-squares-off the moment a live price crosses either level." />}
                <InputGroup size="sm" style={{ width: 120 }}>
                  <InputGroup.Text>T</InputGroup.Text>
                  <Form.Control
                    type="number"
                    placeholder="pts"
                    value={targetPoints}
                    onChange={(e) => setTargetPoints(e.target.value)}
                    min="0"
                    step="0.5"
                  />
                </InputGroup>
                <InputGroup size="sm" style={{ width: 120 }}>
                  <InputGroup.Text>SL</InputGroup.Text>
                  <Form.Control
                    type="number"
                    placeholder="pts"
                    value={slPoints}
                    onChange={(e) => setSlPoints(e.target.value)}
                    min="0"
                    step="0.5"
                  />
                </InputGroup>
                <Button variant="outline-primary" size="sm" disabled={busy} onClick={handleSetTargetSL}>
                  {editing ? 'Save' : 'Set'}
                </Button>
                {editing && (
                  <Button variant="outline-secondary" size="sm" disabled={busy} onClick={stopEditing}>
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
