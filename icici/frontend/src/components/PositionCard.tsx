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

  const hasTargetSet = !!trade.targetPrice || !!trade.stopLossPrice;

  const handleSetTargetSL = () => {
    const tp = targetPoints ? parseFloat(targetPoints) : 0;
    const sl = slPoints ? parseFloat(slPoints) : 0;
    if (tp <= 0 && sl <= 0) return;
    setTargetStopLoss(trade.token, tp, sl);
    setTargetPoints('');
    setSlPoints('');
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
                onClick={() => squareOff(trade.tsym, trade.quantity)}
              >
                Square Off
              </Button>
            </Col>
          )}
        </Row>

        {/* Target Price & Stop Loss */}
        {!closed && (
          <div className="mt-2 pt-2 border-top">
            {hasTargetSet ? (
              <small className="text-muted">
                Target: <span className="fw-bold text-success">&#8377;{trade.targetPrice?.toFixed(2)}</span>
                {' '}&middot;{' '}
                Stop Loss: <span className="fw-bold text-danger">&#8377;{trade.stopLossPrice?.toFixed(2)}</span>
              </small>
            ) : (
              <div className="d-flex align-items-center gap-2">
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
                <Button variant="outline-primary" size="sm" onClick={handleSetTargetSL}>
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
