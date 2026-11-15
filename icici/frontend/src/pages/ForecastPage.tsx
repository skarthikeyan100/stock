import ContractorLayout from '../components/ContractorLayout';
import ContractorTrades from '../components/ContractorTrades';
import { Alert, Card } from 'react-bootstrap';

// Beginner (Individual) home. The Up/Down forecast panel is added with the forecast engine (spec v2.1 sections 7 and 8); until then the page shows
// the read-only trades view.
export default function ForecastPage() {
  return (
    <ContractorLayout>
      <Alert variant="info">Flash Forecast opens soon.</Alert>
      <Card><Card.Header>Resulting trades (read-only)</Card.Header><Card.Body><ContractorTrades /></Card.Body></Card>
    </ContractorLayout>
  );
}
