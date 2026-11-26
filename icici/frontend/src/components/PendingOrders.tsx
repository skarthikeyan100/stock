import { Alert, Button, Card } from 'react-bootstrap';
import { useTrading } from '../context/TradingContext';

// What happened to the orders placed at a clicked price, and the ones still resting (each can be cancelled).
export default function PendingOrders() {
  const { locked, tradingBlocked, orderError, clearError } = useTrading();
  if (!locked) return null;
  return (
    <>
      {/* The order panel (which normally shows errors) is hidden while trading is blocked; square-off and cancel still report here. */}
      {tradingBlocked && orderError && (
        <Alert variant="danger" className="py-2 mb-2" dismissible onClose={clearError}>{orderError}</Alert>
      )}
      {locked.notices.map((n) => (
        <Alert key={n.id} variant={n.variant} className="py-2 mb-2" dismissible onClose={() => locked.dismissNotice(n.id)}>
          {n.text}
        </Alert>
      ))}
      {locked.pending.length > 0 && (
        <Card className="mt-3 border-warning">
          <Card.Header className="py-1 small fw-bold">Pending orders ({locked.pending.length})</Card.Header>
          <Card.Body className="py-2">
            {locked.pending.map((o) => (
              <div key={`${o.broker}:${o.orderId}`} className="d-flex justify-content-between align-items-center gap-2 py-1">
                <div className="small">
                  <span className={`fw-bold ${o.action === 'Buy' ? 'text-success' : 'text-danger'}`}>{o.action.toUpperCase()}</span>{' '}
                  {o.quantity} {o.tsym} at &#8377;{o.price.toFixed(2)} <span className="text-uppercase text-muted">{o.broker}</span>
                  <div className="text-muted">
                    {o.filled > 0
                      ? o.action === 'Buy' ? `${o.filled} of ${o.quantity} filled - the rest is cancelled shortly so the filled part gets its target / stop` : `${o.filled} of ${o.quantity} filled`
                      : 'Waiting to fill - stays until filled, cancelled or the market closes'}
                  </div>
                </div>
                <Button variant="outline-secondary" size="sm" onClick={() => void locked.cancelOrder(o)}>
                  Cancel
                </Button>
              </div>
            ))}
          </Card.Body>
        </Card>
      )}
    </>
  );
}
