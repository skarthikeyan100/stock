import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Card, Button, ButtonGroup } from 'react-bootstrap';
import ThemeToggle from '../components/ThemeToggle';
import LevelTable, { Level } from '../components/LevelTable';

// Public page (no login): how Beginner and Advanced accounts differ, before anyone signs up.
export default function LevelsPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<'both' | Level>('both');
  return (
    <div className="rules-bg position-relative py-4">
      <div className="position-absolute top-0 start-0 m-3"><ThemeToggle /></div>
      <Container style={{ maxWidth: 820 }}>
        <Card className="shadow-lg border-0">
          <Card.Body className="p-4">
            <h2 className="text-center mb-1 fw-bold">Beginner and Advanced accounts</h2>
            <p className="text-center text-muted mb-4">Everyone starts as a Beginner. You can request Advanced later, or become Advanced at once by giving a GSTIN. Advanced is permanent: there is no way back to Beginner.</p>
            <div className="d-flex justify-content-center mb-3">
              <ButtonGroup aria-label="Show">
                <Button variant={view === 'both' ? 'primary' : 'outline-primary'} onClick={() => setView('both')}>Compare both</Button>
                <Button variant={view === 'beginner' ? 'primary' : 'outline-primary'} onClick={() => setView('beginner')}>Beginner rules</Button>
                <Button variant={view === 'advanced' ? 'primary' : 'outline-primary'} onClick={() => setView('advanced')}>Advanced rules</Button>
              </ButtonGroup>
            </div>
            <LevelTable only={view === 'both' ? undefined : view} />
            <p className="small text-muted">Advanced gives you more control and more room to lose. Loss limits are a percentage of your allocated capital; if a limit is reached, your positions are squared off and trading stops (for the day, or for good if the weekly limit is hit).</p>
            <div className="d-grid"><Button variant="secondary" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}>Back</Button></div>
          </Card.Body>
        </Card>
      </Container>
    </div>
  );
}
