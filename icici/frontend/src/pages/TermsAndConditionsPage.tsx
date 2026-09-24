import { Container } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import './LegalPages.css';

export default function TermsAndConditionsPage() {
  const navigate = useNavigate();

  return (
    <div className="legal-page">
      <nav className="legal-nav">
        <span className="legal-nav-brand" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
          PropFirm
        </span>
      </nav>

      <Container className="legal-content">
        <h1>Terms & Conditions</h1>
        <p className="last-updated">Last Updated: September 2026</p>

        <section>
          <h2>1. Acceptance of Terms</h2>
          <p>
            By accessing and using the PropFirm Trading Platform ("Platform"), you agree to be bound by these Terms & Conditions and our Privacy Policy. If you do not agree with any part of these terms, you must stop using the Platform immediately. Your continued use of the Platform constitutes acceptance of any modifications to these terms.
          </p>
        </section>

        <section>
          <h2>2. Platform Overview and Eligibility</h2>

          <h3>2.1 Platform Description</h3>
          <p>
            PropFirm is a proprietary trading platform that provides qualified traders with capital and infrastructure to trade NIFTY index options. We partner with authorized brokers to execute trades on your behalf using your trading strategy. This is a profit-sharing arrangement where PropFirm and traders split the profits generated.
          </p>

          <h3>2.2 Eligibility Requirements</h3>
          <p>You must meet all of the following requirements to use the Platform:</p>
          <ul>
            <li>Be at least 18 years old</li>
            <li>Be a resident of India</li>
            <li>Have a valid PAN (Permanent Account Number)</li>
            <li>Have completed KYC (Know Your Customer) verification</li>
            <li>Provide accurate and complete personal and financial information</li>
            <li>Have an active bank account for fund transfers and withdrawals</li>
          </ul>

          <h3>2.3 Account Responsibility</h3>
          <p>
            You are solely responsible for maintaining the confidentiality of your login credentials. You are liable for all activities conducted through your account. Any unauthorized use must be reported immediately to our support team.
          </p>
        </section>

        <section>
          <h2>3. Trading Rules & Guidelines</h2>

          <h3>3.1 Profit Sharing Model</h3>
          <ul>
            <li>You retain 25% of net profits generated through your trades</li>
            <li>PropFirm retains 75% of net profits</li>
            <li>There is no upfront capital contribution required from you</li>
            <li>Profits are calculated and payable on a weekly basis (every Wednesday)</li>
          </ul>

          <h3>3.2 Daily Loss Limit</h3>
          <ul>
            <li><strong>Threshold:</strong> Your realized loss on any single trading day may not exceed 25% of your allocated investment capital</li>
            <li><strong>Example:</strong> If allocated ₹100,000, daily loss limit = ₹25,000</li>
            <li><strong>Consequence:</strong> When this limit is breached, your active positions will be automatically squared off and further order placement will be restricted until the next trading day</li>
            <li><strong>Profit Protection:</strong> Accumulated profits earned are NOT affected by daily loss limit breach</li>
          </ul>

          <h3>3.3 Weekly Loss Limit</h3>
          <ul>
            <li><strong>Threshold:</strong> Your total realized loss across a trading week (Wednesday through Tuesday) may not exceed 50% of your allocated investment capital</li>
            <li><strong>Example:</strong> If allocated ₹100,000, weekly loss limit = ₹50,000</li>
            <li><strong>Consequence:</strong> When this limit is breached, all open positions will be automatically squared off, further order placement will be restricted, and ALL ACCUMULATED PROFITS since your last payout will be FORFEITED</li>
            <li><strong>Critical:</strong> A weekly loss breach results in profit forfeiture - protect your gains by managing risk carefully</li>
          </ul>

          <h3>3.4 Simultaneous Trade Limits</h3>
          <ul>
            <li>The number of simultaneous open trades depends on your account configuration:
              <ul>
                <li>If configured by <strong>fixed lot size</strong>: Multiple positions can run simultaneously</li>
                <li>If configured by <strong>total investment amount</strong>: Your entire allocated capital is committed to one trade at a time (only one open position allowed)</li>
              </ul>
            </li>
            <li><strong>Daily Trade Limit:</strong> You may place at most 10 trades in one calendar day</li>
            <li>These limits are checked before every order is placed (on the first leg of the trade) and violations will result in order rejection</li>
          </ul>

          <h3>3.5 Capital Allocation</h3>
          <ul>
            <li>PropFirm allocates trading capital to your account based on your account tier and past performance</li>
            <li>Capital allocation may be adjusted based on your trading performance and compliance with platform rules</li>
            <li>You must trade within your allocated capital limit</li>
            <li>Exceeding capital allocation may result in position closure and account suspension</li>
          </ul>
        </section>

        <section>
          <h2>4. Risk Disclaimers</h2>

          <h3>4.1 Trading Risk Acknowledgment</h3>
          <p>
            <strong>You acknowledge and accept that options trading involves substantial risk of loss. The following risks are inherent to trading and cannot be eliminated:</strong>
          </p>
          <ul>
            <li><strong>Total Loss Risk:</strong> You can lose your entire allocated capital in a single trade or series of trades</li>
            <li><strong>Profit Forfeiture:</strong> Exceeding the weekly loss limit will result in forfeiture of ALL accumulated profits, regardless of magnitude</li>
            <li><strong>Volatility Risk:</strong> Options prices are highly volatile and can move drastically in seconds</li>
            <li><strong>Liquidity Risk:</strong> During low-liquidity periods, order execution may occur at unfavorable prices or may fail entirely</li>
            <li><strong>Technology Risk:</strong> Network outages, system failures, or platform glitches may prevent order placement or closure</li>
            <li><strong>Leverage Risk:</strong> Options provide leveraged exposure, amplifying both gains and losses</li>
            <li><strong>Expiry Risk:</strong> Options contracts expire and lose value as expiration approaches</li>
          </ul>

          <h3>4.2 Market Conditions</h3>
          <p>
            Market conditions may change rapidly and unexpectedly. We do not guarantee the availability of market data, quotes, or execution of trades during market disruptions, gaps, or limit-up/limit-down conditions.
          </p>

          <h3>4.3 No Guaranteed Returns</h3>
          <p>
            Past performance is not indicative of future results. We do not guarantee any profits or minimum returns. Trading results depend entirely on market conditions and your trading decisions.
          </p>

          <h3>4.4 Psychological Risk</h3>
          <p>
            Trading involves emotional stress and decision-making under pressure. Poor emotional management can lead to significant losses. Trader acknowledges responsibility for managing psychological factors.
          </p>
        </section>

        <section>
          <h2>5. Nifty Expiry Day Rules</h2>
          <ul>
            <li><strong>Automatic Squareoff:</strong> All open positions are automatically squared off by 3:15 PM on Tuesday (Nifty expiry day)</li>
            <li><strong>No Manual Override:</strong> Users cannot prevent this automatic closure</li>
            <li><strong>Remaining Open Positions:</strong> Any positions still open after 3:15 PM on expiry Tuesday will be forcefully closed by the platform</li>
            <li><strong>Rationale:</strong> This rule protects your account from expiry-related losses and ensures compliance with exchange regulations</li>
          </ul>
        </section>

        <section>
          <h2>6. Broker Relationships</h2>

          <h3>6.1 Broker Partners</h3>
          <p>
            PropFirm executes trades through multiple authorized broker partners:
          </p>
          <ul>
            <li>ICICI Direct (Breeze)</li>
            <li>Zerodha (Kite)</li>
            <li>Alice Blue (ANT)</li>
          </ul>

          <h3>6.2 Broker Terms Apply</h3>
          <p>
            In addition to these Terms, you are also subject to the terms and conditions of the broker partner through which your trades are executed. By using our Platform, you agree to comply with:
          </p>
          <ul>
            <li>Your broker's account agreement and terms of service</li>
            <li>Broker position limits and trading rules</li>
            <li>Market-wide trading halts and circuit breaker rules</li>
            <li>Broker-specific restrictions on order types or position sizing</li>
          </ul>

          <h3>6.3 Broker Account Ownership</h3>
          <p>
            Your trading account is held with the broker partner. PropFirm is an intermediary platform that routes your orders to the broker. The broker is the primary holder of your positions and is responsible for settlement and clearance.
          </p>

          <h3>6.4 No PropFirm Liability for Broker Actions</h3>
          <p>
            PropFirm is not liable for:
          </p>
          <ul>
            <li>Broker-side system failures, outages, or technical glitches</li>
            <li>Broker rejection of orders or forced position closure</li>
            <li>Broker margin or collateral requirements</li>
            <li>Broker fees, charges, or rate changes</li>
            <li>Any losses resulting from broker-side issues</li>
          </ul>
        </section>

        <section>
          <h2>7. Payment and Settlements</h2>

          <h3>7.1 Profit Payouts</h3>
          <ul>
            <li>Profits are calculated based on closed trades (realized P&L only)</li>
            <li>Payouts are processed every Wednesday</li>
            <li>Minimum payout threshold may apply</li>
            <li>Payouts are made to the bank account registered during account opening via NEFT/IMPS</li>
            <li>Processing time: 1-3 business days after payout date</li>
          </ul>

          <h3>7.2 Loss Responsibility</h3>
          <p>
            You bear full responsibility for all losses incurred. There is no compensation, reimbursement, or loss recovery for trading losses. The profit-sharing model means you share in gains but also accept losses independently.
          </p>

          <h3>7.3 Charges and Fees</h3>
          <ul>
            <li>PropFirm does not charge account opening or maintenance fees</li>
            <li>Broker partner trading fees and charges (brokerage, turnover tax, etc.) apply as per their tariff</li>
            <li>Platform fees for strategy services may apply and will be disclosed at the time of use</li>
          </ul>

          <h3>7.4 Tax Responsibility</h3>
          <p>
            You are solely responsible for all tax obligations related to your trading profits. You must comply with applicable income tax laws and file required tax returns. PropFirm will provide trading statements but does not provide tax advice.
          </p>
        </section>

        <section>
          <h2>8. Limitation of Liability</h2>

          <h3>8.1 No Liability for Trading Losses</h3>
          <p>
            <strong>PropFirm shall not be held responsible or liable for any losses, damages, or consequences whatsoever resulting from:</strong>
          </p>
          <ul>
            <li>Your trading decisions or strategy execution</li>
            <li>Market movements, price volatility, or adverse market conditions</li>
            <li>Losses from exceeding daily or weekly loss limits</li>
            <li>Profit forfeiture due to weekly loss limit breach</li>
            <li>Forced position closures due to risk management rules</li>
            <li>Order rejections or execution at unfavorable prices</li>
            <li>Technology failures, platform outages, or connectivity issues</li>
            <li>Broker-side failures, system crashes, or operational issues</li>
            <li>Regulatory actions or exchange-mandated closures</li>
            <li>Any other cause related to trading or market participation</li>
          </ul>

          <h3>8.2 Disclaimer of Warranties</h3>
          <p>
            THE PLATFORM IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
          </p>

          <h3>8.3 Cap on Liability</h3>
          <p>
            IN NO EVENT SHALL PROPFIRM BE LIABLE FOR:
          </p>
          <ul>
            <li>Any indirect, incidental, special, consequential, or punitive damages</li>
            <li>Loss of profits, data, or business opportunities</li>
            <li>Any amount exceeding the total value of your account at the time of the claim</li>
          </ul>

          <h3>8.4 Sole Remedy</h3>
          <p>
            Your sole remedy for any grievance is limited to account review and, if applicable, position reconciliation. Under no circumstances will PropFirm compensate for trading losses or profit forfeiture.
          </p>
        </section>

        <section>
          <h2>9. Indemnification</h2>
          <p>
            You agree to indemnify, defend, and hold harmless PropFirm and its officers, directors, employees, and agents from any and all claims, damages, losses, liabilities, and expenses (including attorney's fees) arising from:
          </p>
          <ul>
            <li>Your use of the Platform</li>
            <li>Your violation of these Terms</li>
            <li>Your trading activities and market participation</li>
            <li>Your breach of applicable laws or regulations</li>
            <li>Any content or information you provide to PropFirm</li>
          </ul>
        </section>

        <section>
          <h2>10. Prohibited Activities</h2>
          <p>You agree NOT to:</p>
          <ul>
            <li>Use the Platform for any illegal or unauthorized purpose</li>
            <li>Manipulate markets, engage in wash trading, or coordinate trades with other users</li>
            <li>Share your account credentials with other individuals</li>
            <li>Attempt to hack, reverse-engineer, or interfere with platform security</li>
            <li>Use automated bots or scrapers to access the Platform</li>
            <li>Abuse risk management features or exploit system vulnerabilities</li>
            <li>Provide false or misleading information during KYC verification</li>
            <li>Conduct any activity that violates NSE/SEBI regulations or laws</li>
            <li>Harass, abuse, or send threatening messages to PropFirm staff</li>
            <li>Disclose proprietary platform information or trading strategies</li>
          </ul>
        </section>

        <section>
          <h2>11. Account Suspension and Termination</h2>

          <h3>11.1 Grounds for Suspension</h3>
          <p>PropFirm reserves the right to suspend your account if you:</p>
          <ul>
            <li>Violate any of these Terms & Conditions</li>
            <li>Fail KYC re-verification or compliance checks</li>
            <li>Engage in prohibited activities or market manipulation</li>
            <li>Breach applicable laws or regulatory requirements</li>
            <li>Repeatedly trigger risk management limits</li>
          </ul>

          <h3>11.2 Account Termination</h3>
          <p>
            You may terminate your account at any time by providing written notice. PropFirm may terminate your account without notice for serious violations or regulatory non-compliance.
          </p>

          <h3>11.3 Consequences of Termination</h3>
          <ul>
            <li>All open positions will be immediately closed</li>
            <li>Access to the Platform will be revoked</li>
            <li>Remaining capital (if any) will be returned to your registered bank account</li>
            <li>Final account statements and tax documents will be provided</li>
          </ul>
        </section>

        <section>
          <h2>12. Compliance and Legal Authority</h2>

          <h3>12.1 Broker Compliance</h3>
          <p>
            All trades are executed through authorized broker partners who are registered with relevant market authorities. PropFirm ensures that trading activities comply with broker partner requirements and market regulations.
          </p>

          <h3>12.2 Legal Authority Cooperation</h3>
          <p>
            You authorize PropFirm to disclose your trading data, positions, and account information to legal authorities, courts, or law enforcement agencies when compelled by valid legal process.
          </p>

          <h3>12.3 KYC Requirements</h3>
          <p>
            PropFirm requires complete and accurate Know Your Customer (KYC) information for account opening and ongoing compliance. You must provide valid identification and address verification. Enhanced verification may be requested for account security or dispute resolution purposes.
          </p>
        </section>

        <section>
          <h2>13. Dispute Resolution</h2>

          <h3>13.1 Grievance Redressal</h3>
          <p>
            Any disputes or grievances must be submitted in writing to our support team within 30 days of the incident. We will investigate and respond within 7 business days.
          </p>

          <h3>13.2 Arbitration</h3>
          <p>
            All disputes shall be resolved through binding arbitration under the Arbitration and Conciliation Act, 1996, conducted by a single arbitrator appointed mutually by the parties. The arbitration shall be conducted in English in the jurisdiction of India.
          </p>

          <h3>13.3 Limitation Period</h3>
          <p>
            Any claim or dispute must be filed within 6 months of the incident or loss. Claims filed after this period will be time-barred and rejected.
          </p>
        </section>

        <section>
          <h2>14. Intellectual Property</h2>
          <p>
            All content, software, strategies, and materials on the PropFirm Platform are protected by copyright and intellectual property laws. You are granted a limited, non-exclusive license to use the Platform for personal trading only. You may not reproduce, distribute, or commercialize any Platform content without written permission.
          </p>
        </section>

        <section>
          <h2>15. Third-Party Links and Services</h2>
          <p>
            Our Platform may contain links to external websites and services (broker portals, NSE website, regulatory sites). These external services are not under PropFirm's control. We are not responsible for their content, accuracy, or practices. Use external links at your own risk.
          </p>
        </section>

        <section>
          <h2>16. Modifications to Terms</h2>
          <p>
            PropFirm reserves the right to modify these Terms & Conditions at any time. Material changes will be communicated via email or a prominent platform notice. Your continued use of the Platform constitutes acceptance of modified terms.
          </p>
        </section>

        <section>
          <h2>17. Governing Law</h2>
          <p>
            These Terms & Conditions are governed by and construed in accordance with the laws of India, without regard to its conflict of law principles. Both parties irrevocably submit to the jurisdiction of the courts of India.
          </p>
        </section>

        <section>
          <h2>18. Severability</h2>
          <p>
            If any provision of these Terms is found to be invalid or unenforceable, that provision shall be severed, and the remaining provisions shall continue in full force and effect.
          </p>
        </section>

        <section>
          <h2>19. Entire Agreement</h2>
          <p>
            These Terms & Conditions, along with our Privacy Policy, constitute the entire agreement between you and PropFirm regarding your use of the Platform. No prior discussions, representations, or warranties are binding.
          </p>
        </section>

        <section>
          <h2>20. Contact Information</h2>
          <p>
            For questions about these Terms & Conditions or to report compliance concerns, please contact:
          </p>
          <ul>
            <li><strong>Email:</strong> [support@propfirm.com]</li>
            <li><strong>Address:</strong> [Company Address]</li>
            <li><strong>Response Time:</strong> 7 business days for formal inquiries</li>
          </ul>
        </section>

        <p className="policy-footer">
          By accepting these Terms & Conditions during account registration, you confirm that you have read, understood, and agree to be bound by all provisions herein. This is a binding agreement between you and PropFirm for participation in our profit-sharing trading platform. These terms shall remain binding for the duration of your use of the Platform and survive account termination.
        </p>
      </Container>
    </div>
  );
}
