import { useNavigate } from 'react-router-dom';
import { Container, Card, Button, ListGroup } from 'react-bootstrap';

const rules = [
  'Multiple trades are permitted up to your configured quantity limit. Manage your positions within this threshold.',
  'The maximum permissible loss per session is \u20B915,000. All trades must be managed within this risk threshold.',
  'If losses reach \u20B915,000, your active positions may be automatically squared off and further order placement will be restricted until the next session.',
];

export default function RulesPage() {
  const navigate = useNavigate();

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
