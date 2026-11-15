import { Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

// The public privacy notice of the contractor portal (DPDP Act, 2023). It replaces the old trading-platform policy, which is no longer routed.
export default function PrivacyNoticePage() {
  return (
    <div className="py-4">
      <Container style={{ maxWidth: 820 }}>
        <div className="d-flex align-items-center gap-3 mb-3">
          <Link to="/" className="fw-bold text-decoration-none">Nivedha Tech</Link>
          <ThemeToggle />
        </div>
        <h1 className="h3">Privacy Notice</h1>
        <p className="text-muted">Nivedha Tech – Forecasting Contractor Portal · Last updated: November 2026</p>

        <h2 className="h5 mt-4">1. Who this is for</h2>
        <p>This portal is a private programme for contractors who have been invited and have accepted their services agreement. Nobody else has an account, and we do not collect data from visitors beyond what is needed to run the site securely.</p>

        <h2 className="h5 mt-4">2. What we collect</h2>
        <ul>
          <li><strong>Identity and contact:</strong> your name, email address and address; for a business, its legal name, signatory and designated forecaster.</li>
          <li><strong>Tax and registration:</strong> PAN, GSTIN and, for a business, its SEBI registration number and validity.</li>
          <li><strong>Payment:</strong> bank account details and the payments we make to you, with their reference numbers.</li>
          <li><strong>Your work on the portal:</strong> the forecasts or recommendations you submit, their time and outcome, your statements and invoices.</li>
          <li><strong>Records of acceptance:</strong> the agreement version you accepted, the time, your IP address and browser details.</li>
          <li><strong>Technical data:</strong> a session cookie that keeps you signed in, and security logs.</li>
        </ul>

        <h2 className="h5 mt-4">3. Why we use it</h2>
        <p>To perform the agreement with you, to pay you, to meet tax and legal obligations, to keep the programme secure and to keep an accurate record of what each party agreed and did. We do not sell your data and we do not use it for advertising.</p>

        <h2 className="h5 mt-4">4. Who we share it with</h2>
        <p>Only our bank (to pay you), tax and other authorities where the law requires it, and professional advisers bound by confidentiality. We do not share your data with anyone else.</p>

        <h2 className="h5 mt-4">5. How we protect it</h2>
        <p>PAN, GSTIN and bank details are stored encrypted and are visible only to the owner of the programme, who sees them masked unless a full view is needed. Access to the portal is by a personal invitation link; a session lasts as long as your agreement allows and can be ended by us at any time.</p>

        <h2 className="h5 mt-4">6. How long we keep it</h2>
        <p>For as long as the agreement runs and for the period the law requires for tax and accounting records afterwards. Then we delete or anonymise it.</p>

        <h2 className="h5 mt-4">7. Your rights</h2>
        <p>You may ask to access, correct or erase your personal data, withdraw your consent where it is the basis of processing, and complain to us or to the Data Protection Board of India. Some records cannot be erased while the law requires us to keep them. Write to <a href="mailto:admin@nivedhatech.com">admin@nivedhatech.com</a>; we answer within 30 days.</p>

        <h2 className="h5 mt-4">8. Cookies</h2>
        <p>We use one cookie, to keep you signed in. If you clear it or log out, you will need a new invitation. We use no advertising or tracking cookies.</p>

        <h2 className="h5 mt-4">9. Changes</h2>
        <p>If we change this notice we will tell contractors by email before the change takes effect.</p>
      </Container>
    </div>
  );
}
