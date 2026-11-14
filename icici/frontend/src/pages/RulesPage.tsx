import { useNavigate } from 'react-router-dom';
import { Container, Card, Button, ListGroup } from 'react-bootstrap';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import LevelTable, { useLevelRules } from '../components/LevelTable';

export default function RulesPage() {
  const navigate = useNavigate();
  const { user, termsAccepted, logout, setTermsAccepted } = useAuth();

  // Reachable two ways: the forced first-login flow (termsAccepted is still
  // false - LoginPage redirects here) and a voluntary re-read from the
  // profile page (termsAccepted already true). Only the first one should
  // treat "Close" as declining and log the user out - a returning user just
  // checking the rules again must not be logged out for clicking Close.
  const handleClose = async () => {
    if (termsAccepted) {
      navigate('/profile');
      return;
    }
    if (await logout()) navigate('/');
  };

  const level = user?.proficiencyLevel === 'advanced' ? 'advanced' : 'beginner';
  const { data } = useLevelRules();
  // The percentages are the user's own level's (from the server, which reads config.yml), applied to their allocated capital.
  const lim = data?.limits[level];
  const investmentAmount = user?.accountCapital ?? user?.investmentAmount ?? lim?.capital ?? 100000;
  const dailyPercent = lim?.daily;
  const weeklyPercent = lim?.weekly;
  const dailyLimit = dailyPercent != null ? Math.round(investmentAmount * (dailyPercent / 100)) : null;
  const weeklyLimit = weeklyPercent != null ? Math.round(investmentAmount * (weeklyPercent / 100)) : null;

  const rules = !lim ? [] : [
    'The number of simultaneous trades depends on how your account is configured. If your account trades by fixed lot size, multiple positions can run at the same time. If it trades by total investment amount, your entire allocated capital is committed to each trade, and at most 3 trades per day are allowed. These trade-count and investment limits are checked before every order is placed (on the first leg of the trade) and simply reject it if breached.',
    `Maximum daily drawdown: your realized loss on any single day may not exceed ${dailyPercent}% of your allocated investment amount (₹${dailyLimit!.toLocaleString('en-IN')} for your account). If this limit is reached, your active positions will be automatically squared off, further order placement will be restricted until the next trading day, and all profit accumulated since your last payout is forfeited, even if you had made 100% profit before that day.`,
    `Maximum weekly loss: your total realized loss across a trading week (Wednesday through Tuesday) may not exceed ${weeklyPercent}% of your allocated investment amount (₹${weeklyLimit!.toLocaleString('en-IN')} for your account). If this limit is breached, remaining open positions will be automatically squared off and your account will be closed.`,
    `Maximum loss on one trade: one trade that hits its stop-loss may not lose more than ${lim.perTrade}% of your allocated capital, so a cheap option or a wide stop-loss buys a smaller position.`,
  ];

  return (
    <div className="rules-bg d-flex align-items-center justify-content-center position-relative">
      <div className="position-absolute top-0 start-0 m-3">
        <ThemeToggle />
      </div>
      <Container style={{ maxWidth: 780 }}>
        <Card className="shadow-lg border-0">
          <Card.Body className="p-4">
            <h2 className="text-center mb-1 fw-bold">PropFirm Trading Platform</h2>
            <p className="text-center text-muted mb-4">Trading Rules &amp; Guidelines</p>

            <p className="text-center small text-muted mb-2">Your account is <strong>{level === 'advanced' ? 'Advanced' : 'Beginner'}</strong>.</p>
            <LevelTable highlight={level} />
            {level === 'beginner' && <p className="small text-muted">Want Search &amp; Buy and your own target and stop-loss? You can request Advanced on your <a href="/profile#upgrade">Profile</a> page. Advanced is permanent.</p>}

            <ListGroup variant="flush" className="mb-4">
              {rules.map((rule, i) => (
                <ListGroup.Item key={i} className="d-flex align-items-start px-0">
                  <span className="rule-number me-3">{i + 1}</span>
                  <span>{rule}</span>
                </ListGroup.Item>
              ))}
            </ListGroup>

            <div className="d-grid gap-2">
              <Button
                variant="primary"
                size="lg"
                onClick={() => {
                  setTermsAccepted(true);
                  navigate('/trade');
                }}
              >
                {termsAccepted ? 'Continue' : 'Accept & Continue'}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={handleClose}
              >
                {termsAccepted ? 'Back' : 'Close'}
              </Button>
            </div>
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
