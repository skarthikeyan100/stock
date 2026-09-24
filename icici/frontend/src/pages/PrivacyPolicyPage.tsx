import { Container } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import './LegalPages.css';

export default function PrivacyPolicyPage() {
  const navigate = useNavigate();

  return (
    <div className="legal-page">
      <nav className="legal-nav">
        <span className="legal-nav-brand" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
          PropFirm
        </span>
      </nav>

      <Container className="legal-content">
        <h1>Privacy Policy</h1>
        <p className="last-updated">Last Updated: September 2026</p>

        <section>
          <h2>1. Introduction</h2>
          <p>
            PropFirm Trading Platform ("PropFirm", "we", "us", "our", or "Company") is committed to protecting your privacy and ensuring you have a positive experience on our website and platform. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our services.
          </p>
          <p>
            PropFirm is a proprietary trading platform operated in compliance with Indian securities regulations and the guidelines set forth by the National Stock Exchange (NSE) and Securities and Exchange Board of India (SEBI).
          </p>
        </section>

        <section>
          <h2>2. Information We Collect</h2>

          <h3>2.1 Information You Provide</h3>
          <ul>
            <li><strong>Account Registration:</strong> Email address, name, phone number, date of birth, gender, address</li>
            <li><strong>KYC Verification:</strong> Government-issued ID (PAN card, Aadhaar number), address proof, date of birth proof, bank account details</li>
            <li><strong>Trading Information:</strong> Bank account information, investment preferences, trading history, positions held, orders placed</li>
            <li><strong>Profile Information:</strong> Profile picture, communication preferences, investment limits</li>
          </ul>

          <h3>2.2 Information Collected Automatically</h3>
          <ul>
            <li><strong>Session Cookies:</strong> Browser session information for authentication and user identification</li>
            <li><strong>Log Data:</strong> IP address, browser type, operating system, pages visited, timestamps</li>
            <li><strong>Trading Data:</strong> Real-time market quotes, order execution details, fills, P&L calculations</li>
            <li><strong>Device Information:</strong> Device identifiers, device type, device settings</li>
          </ul>
        </section>

        <section>
          <h2>3. How We Use Your Information</h2>

          <h3>3.1 Primary Purposes</h3>
          <ul>
            <li>To create and maintain your trading account</li>
            <li>To process and execute your trading orders</li>
            <li>To verify your identity and comply with KYC/AML regulations</li>
            <li>To calculate profits, losses, and manage your trading capital</li>
            <li>To provide real-time market data and trading functionality</li>
            <li>To send order confirmations, statements, and transaction updates</li>
            <li>To manage your loss limits and enforce risk management rules</li>
          </ul>

          <h3>3.2 Secondary Purposes</h3>
          <ul>
            <li>To improve our platform and user experience</li>
            <li>To detect and prevent fraud or unauthorized access</li>
            <li>To comply with legal obligations and regulatory requirements</li>
            <li>To conduct internal analysis and system monitoring</li>
            <li>To send platform updates and service announcements (with your consent)</li>
          </ul>
        </section>

        <section>
          <h2>4. Data Storage and Protection</h2>

          <h3>4.1 Data Storage</h3>
          <ul>
            <li><strong>Database:</strong> All personal data is stored in a MongoDB database with encrypted fields for sensitive information (passwords, bank account numbers, PAN, Aadhaar numbers are stored in masked/hashed format only)</li>
            <li><strong>Session Management:</strong> Session cookies are signed with a cryptographic secret and stored server-side</li>
            <li><strong>Trade History:</strong> All trading records, orders, fills, and positions are permanently maintained for regulatory compliance and audit purposes</li>
            <li><strong>Data Retention:</strong> Personal data is retained as long as your account is active and for 7 years after account closure for regulatory compliance</li>
          </ul>

          <h3>4.2 Security Measures</h3>
          <ul>
            <li><strong>Encryption:</strong> Sensitive data is encrypted at rest using industry-standard encryption algorithms</li>
            <li><strong>HTTPS:</strong> All data transmission between your browser and our servers is encrypted using TLS/SSL</li>
            <li><strong>Authentication:</strong> Google OAuth 2.0 for secure authentication; ID tokens are server-side verified</li>
            <li><strong>Session Management:</strong> Secure, signed session cookies with expiration timeouts</li>
            <li><strong>Access Control:</strong> Role-based access control (user, admin); sensitive operations require proper authorization</li>
            <li><strong>Audit Logging:</strong> All user actions and order placements are logged and monitored for security compliance</li>
          </ul>

          <h3>4.3 Data Protection Responsibilities</h3>
          <p>You are responsible for:</p>
          <ul>
            <li>Maintaining the confidentiality of your login credentials</li>
            <li>Not sharing your session with unauthorized persons</li>
            <li>Logging out after each session, especially on shared devices</li>
            <li>Immediately notifying us of any unauthorized access</li>
          </ul>
        </section>

        <section>
          <h2>5. Data Sharing and Disclosure</h2>

          <h3>5.1 We Do NOT Share Your Data With:</h3>
          <ul>
            <li>Third-party marketing or advertising companies</li>
            <li>Data brokers or data aggregators</li>
            <li>Unauthorized external services</li>
          </ul>

          <h3>5.2 We May Share Your Data With:</h3>
          <ul>
            <li><strong>Broker Partners:</strong> ICICI Direct, Zerodha (Kite), Alice Blue (ANT) - to execute your trading orders and manage your positions</li>
            <li><strong>NSE/Exchange:</strong> Trading and position data as required by regulations</li>
            <li><strong>SEBI:</strong> Regulatory compliance data when required by law</li>
            <li><strong>Legal Authorities:</strong> When compelled by court order, subpoena, or legal process</li>
            <li><strong>Compliance Partners:</strong> KYC verification services (masked identity data only)</li>
          </ul>

          <h3>5.3 Data Processing Agreements</h3>
          <p>
            All broker partners and third-party service providers are contractually bound to maintain data confidentiality and use data only for the purposes specified in this Privacy Policy.
          </p>
        </section>

        <section>
          <h2>6. Your Privacy Rights</h2>

          <h3>6.1 You Have the Right To:</h3>
          <ul>
            <li>Access your personal data and trading records</li>
            <li>Request correction of inaccurate data</li>
            <li>Request deletion of data (subject to regulatory retention requirements)</li>
            <li>Opt-out of non-essential communications</li>
            <li>Request a data export in machine-readable format</li>
          </ul>

          <h3>6.2 Exercising Your Rights</h3>
          <p>
            To exercise any of these rights, please contact us at [support email]. We will respond to verified requests within 30 days.
          </p>

          <h3>6.3 Regulatory Retention Requirements</h3>
          <p>
            Certain data (trading records, identity verification documents, financial transactions) must be retained for minimum 7 years for compliance with SEBI and NSE regulations. We cannot delete this data even upon your request due to legal obligations.
          </p>
        </section>

        <section>
          <h2>7. Cookies and Tracking</h2>

          <h3>7.1 Session Cookies</h3>
          <p>
            We use secure, signed session cookies to maintain your authenticated state. These cookies:
          </p>
          <ul>
            <li>Are essential for platform functionality</li>
            <li>Expire automatically after login/logout or session timeout</li>
            <li>Contain your signed session ID only (no sensitive data)</li>
            <li>Are signed with a cryptographic secret (cannot be forged)</li>
          </ul>

          <h3>7.2 Cookie Management</h3>
          <p>
            You can control cookies through your browser settings. However, disabling cookies may impair your ability to use our platform.
          </p>
        </section>

        <section>
          <h2>8. Third-Party Links</h2>
          <p>
            Our platform may contain links to external websites (broker portals, NSE website, etc.). This Privacy Policy does not apply to third-party websites. We recommend reviewing their privacy policies before providing any personal information.
          </p>
        </section>

        <section>
          <h2>9. Children's Privacy</h2>
          <p>
            Our platform is not intended for users under 18 years old. We do not knowingly collect data from minors. If we become aware that a minor has provided us with personal information, we will delete such data immediately.
          </p>
        </section>

        <section>
          <h2>10. International Transfers</h2>
          <p>
            Your data is stored and processed primarily within India. Any international data transfers (if any) are conducted in compliance with applicable data protection laws.
          </p>
        </section>

        <section>
          <h2>11. Data Breach Notification</h2>
          <p>
            In the event of a data breach that compromises personal information, we will notify affected users within 72 hours and cooperate fully with regulatory authorities as required by law.
          </p>
        </section>

        <section>
          <h2>12. Changes to This Privacy Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. Material changes will be communicated to you via email or a prominent notice on the platform. Your continued use of the platform constitutes acceptance of any changes.
          </p>
        </section>

        <section>
          <h2>13. Contact Us</h2>
          <p>
            If you have questions about this Privacy Policy, please contact us at:
          </p>
          <ul>
            <li><strong>Email:</strong> [support@propfirm.com]</li>
            <li><strong>Address:</strong> [Company Address]</li>
            <li><strong>Response Time:</strong> 30 days for privacy-related inquiries</li>
          </ul>
        </section>

        <p className="policy-footer">
          This Privacy Policy is provided in English. In case of any conflicts between the English version and any translated versions, the English version shall prevail.
        </p>
      </Container>
    </div>
  );
}
