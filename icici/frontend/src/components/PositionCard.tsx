import { useState } from 'react';
import { Card, Button, Badge, Row, Col, Form, InputGroup } from 'react-bootstrap';
import { useTrading, Trade } from '../context/TradingContext';

export default function PositionCard({ trade, closed }: { trade: Trade; closed?: boolean }) {
  const { squareOff, setTargetStopLoss } = useTrading();
  const [targetPoints, setTargetPoints] = useState('');
  const [slPoints, setSlPoints] = useState('');

  const pnl = closed
    ? (trade.realizedPnL || 0)
    : trade.lastTradePrice ? (trade.lastTradePrice - trade.price) * trade.quantity : 0;
  const pnlColor = pnl >= 0 ? 'text-success' : 'text-danger';
  const rightLabel = trade.right === 'call' || trade.right === 'CE' ? 'CE' : 'PE';

  const hasTarget = !!trade.targetPrice;
  const hasStopLoss = !!trade.stopLossPrice;
  const hasTargetSet = hasTarget && hasStopLoss;
  const [busy, setBusy] = useState(false);

  // Only the side(s) the user filled in are sent (0 = leave unset); inputs are cleared only if the server accepted it.
  const handleSetTargetSL = async () => {
    if (busy) return;
    const tp = targetPoints ? parseFloat(targetPoints) : 0;
    const sl = slPoints ? parseFloat(slPoints) : 0;
    if (!(Number.isFinite(tp) && tp >= 0) || !(Number.isFinite(sl) && sl >= 0) || (tp <= 0 && sl <= 0)) return;
    setBusy(true);
    try {
      const ok = await setTargetStopLoss(trade.token, tp, sl);
      if (ok) {
        setTargetPoints('');
        setSlPoints('');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSquareOff = async () => {
    if (busy) return;
    if (!window.confirm(`Square off ${trade.tsym} (qty ${trade.quantity})? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await squareOff(trade.token, trade.quantity);
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
              <Badge bg={rightLabel === 'CE' ? 'primary' : 'warning'} className="ms-2">
                {rightLabel}
              </Badge>
              {closed && (
                <Badge bg="secondary" className="ms-2">Closed</Badge>
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
              <small className="text-muted">Waiting for price...</small>
            )}
          </Col>

          {!closed && (
            <Col xs="auto">
              <Button
                variant="outline-danger"
                disabled={busy}
                onClick={handleSquareOff}
              >
                Square Off
              </Button>
            </Col>
          )}
        </Row>

        {/* Target Price & Stop Loss */}
        {!closed && (
          <div className="mt-2 pt-2 border-top">
            {(hasTarget || hasStopLoss) && (
              <small className="text-muted d-block mb-1">
                Target: <span className="fw-bold text-success">{hasTarget ? <>&#8377;{trade.targetPrice?.toFixed(2)}</> : 'not set'}</span>
                {' '}&middot;{' '}
                Stop Loss: <span className="fw-bold text-danger">{hasStopLoss ? <>&#8377;{trade.stopLossPrice?.toFixed(2)}</> : 'not set'}</span>
              </small>
            )}
            {!hasTargetSet && (
              <div className="d-flex align-items-center gap-2 flex-wrap">
                {!hasTarget && (
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
                )}
                {!hasStopLoss && (
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
                )}
                <Button variant="outline-primary" size="sm" disabled={busy} onClick={handleSetTargetSL}>
                  Set
                </Button>
              </div>
            )}
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
