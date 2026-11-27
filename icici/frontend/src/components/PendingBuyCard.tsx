import { useState } from 'react';
import { Card, Button, Badge, Row, Col } from 'react-bootstrap';
import { useTrading } from '../context/TradingContext';
import type { PendingOrder } from '../context/useLockedOrders';
import { optionRight } from '../utils/optionRight';

// A limit buy that has not filled yet, listed with the active positions until it fills or is cancelled.
export default function PendingBuyCard({ order, showBroker }: { order: PendingOrder; showBroker: boolean }) {
  const { locked } = useTrading();
  const [busy, setBusy] = useState(false);
  const rightLabel = optionRight(order);

  const handleCancel = async () => {
    if (busy || !locked) return;
    setBusy(true);
    try {
      await locked.cancelOrder(order);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-3 shadow-sm">
      <Card.Body>
        <Row className="align-items-center">
          <Col>
            <h5 className="mb-1">
              {order.tsym}
              {rightLabel && (
                <Badge bg={rightLabel === 'CE' ? 'primary' : 'warning'} className="ms-2">
                  {rightLabel}
                </Badge>
              )}
              {showBroker && <Badge bg="dark" className="ms-2 text-uppercase">{order.broker}</Badge>}
              <Badge bg="warning" text="dark" className="ms-2">Pending</Badge>
            </h5>
            <small className="text-muted">
              Qty: {order.quantity} &middot; Limit: &#8377;{order.price.toFixed(2)}
              {order.filled > 0 && <> &middot; {order.filled} filled</>}
            </small>
          </Col>
          <Col xs="auto" className="text-end">
            <Button variant="outline-secondary" disabled={busy || order.unconfirmed} onClick={handleCancel}>
              Cancel
            </Button>
          </Col>
        </Row>
      </Card.Body>
    </Card>
  );
}
