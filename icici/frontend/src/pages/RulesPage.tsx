import { useNavigate } from 'react-router-dom';
import { Container, Card, Button, ListGroup } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';

const DAILY_DRAWDOWN_PERCENT = 25;
const MONTHLY_LOSS_PERCENT = 50;

export default function RulesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const investmentAmount = user?.investmentAmount ?? 100000;
  const dailyLimit = Math.round(investmentAmount * (DAILY_DRAWDOWN_PERCENT / 100));
  const monthlyLimit = Math.round(investmentAmount * (MONTHLY_LOSS_PERCENT / 100));

  const rules = [
    'The number of simultaneous trades depends on how your account is configured. If your account trades by fixed lot size, multiple positions can run at the same time. If it trades by total investment amount, your entire allocated capital is committed to one trade at a time.',
    `Maximum daily drawdown: your realized loss on any single day may not exceed ${DAILY_DRAWDOWN_PERCENT}% of your allocated investment amount (₹${dailyLimit.toLocaleString()} for your account). If this limit is reached, your active positions will be automatically squared off and further order placement will be restricted until the next trading day.`,
    `Maximum monthly loss: your total realized loss across a calendar month may not exceed ${MONTHLY_LOSS_PERCENT}% of your allocated investment amount (₹${monthlyLimit.toLocaleString()} for your account). Breaching either the daily or monthly limit forfeits all profit accumulated since your last payout.`,
    'Maximum trades per day: a single user may place at most 10 trades in one day.',
    'The trade-count and investment limits above are checked before every order is placed (on the first leg of the trade) and simply reject it. The daily and monthly drawdown limits are enforced the moment a closing trade breaches them — remaining open positions are squared off automatically, and further orders are blocked.',
  ];

  return (
    <div className="rules-bg d-flex align-items-center justify-content-center">
      <Container style={{ maxWidth: 600 }}>
        <Card className="shadow-lg border-0">
          <Card.Body className="p-4">
            <h2 className="text-center mb-1 fw-bold">PropFirm Trading Platform</h2>
            <p className="text-center text-muted mb-4">Trading Rules &amp; Guidelines</p>

            <ListGroup variant="flush" className="mb-4">
              {rules.map((rule, i) => (
                <ListGroup.Item key={i} className="d-flex align-items-start px-0">
                  <span className="rule-number me-3">{i + 1}</span>
                  <span>{rule}</span>
                </ListGroup.Item>
              ))}
            </ListGroup>

            <div className="d-grid">
              <Button
                variant="primary"
                size="lg"
                onClick={() => navigate('/app/trade')}
              >
                Accept &amp; Continue
              </Button>
            </div>
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
