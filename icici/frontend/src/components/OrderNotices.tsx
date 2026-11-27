import { Alert } from 'react-bootstrap';
import { useTrading } from '../context/TradingContext';
import { useAuth } from '../context/AuthContext';
import { orderErrorText } from '../utils/orderErrorText';

// Problems with the orders placed at a clicked price (rejected, cancelled elsewhere, placed with an error). Success is shown by the positions.
export default function OrderNotices() {
  const { locked, tradingBlocked, orderError, clearError } = useTrading();
  const { isAdmin } = useAuth();
  if (!locked) return null;
  return (
    <>
      {/* The order panel (which normally shows errors) is hidden while trading is blocked; square-off and cancel still report here. */}
      {tradingBlocked && orderError && (
        <Alert variant="danger" className="py-2 mb-2" dismissible onClose={clearError}>{orderErrorText(orderError, isAdmin)}</Alert>
      )}
      {locked.notices.map((n) => (
        <Alert key={n.id} variant={n.variant} className="py-2 mb-2" dismissible onClose={() => locked.dismissNotice(n.id)}>
          {orderErrorText(n.text, isAdmin)}
        </Alert>
      ))}
    </>
  );
}
