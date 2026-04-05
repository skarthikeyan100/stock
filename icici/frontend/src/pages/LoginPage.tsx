import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { login, isLoggedIn } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoggedIn) navigate('/app/rules', { replace: true });
  }, [isLoggedIn, navigate]);

  return (
    <div className="landing-page">
      {/* Nav */}
      <nav className="landing-nav">
        <span className="landing-nav-brand">PropFirm</span>
        <div className="landing-nav-signin">
          <GoogleLogin
            onSuccess={async (credentialResponse) => {
              try {
                await login(credentialResponse.credential!);
                navigate('/app/rules');
              } catch (e) {
                console.error('Login failed:', e);
              }
            }}
            onError={() => console.error('Google login error')}
          />
        </div>
      </nav>

      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-hero-content">
          <div className="landing-badge">NIFTY Options Trading</div>
          <h1 className="landing-title">
            Trade Smarter.<br />
            <span className="landing-title-accent">Share the Profits.</span>
          </h1>
          <p className="landing-subtitle">
            Join our proprietary trading platform. We provide the capital —
            you bring the skill. Keep 25% of every rupee you earn.
          </p>
          <div className="landing-hero-cta">
            <GoogleLogin
              onSuccess={async (credentialResponse) => {
                try {
                  await login(credentialResponse.credential!);
                  navigate('/app/rules');
                } catch (e) {
                  console.error('Login failed:', e);
                }
              }}
              onError={() => console.error('Google login error')}
            />
          </div>
        </div>
        <div className="landing-hero-graphic">
          <div className="stat-card stat-card-1">
            <div className="stat-value text-success">+25%</div>
            <div className="stat-label">Your Profit Share</div>
          </div>
          <div className="stat-card stat-card-2">
            <div className="stat-value">2×</div>
            <div className="stat-label">Monthly Payouts</div>
          </div>
          <div className="stat-card stat-card-3">
            <div className="stat-value text-warning">₹0</div>
            <div className="stat-label">Capital Required</div>
          </div>
        </div>
      </section>

      {/* How it Works */}
      <section className="landing-section">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">How It Works</h2>
          <p className="landing-section-sub">Three simple steps to start earning</p>
          <div className="steps-row">
            <div className="step-card">
              <div className="step-number">01</div>
              <h4>Sign In & Accept Rules</h4>
              <p>Log in with your Google account and review the trading guidelines before you begin.</p>
            </div>
            <div className="step-connector" />
            <div className="step-card">
              <div className="step-number">02</div>
              <h4>Trade NIFTY Options</h4>
              <p>Use our platform to buy call or put options on NIFTY index within your allocated capital.</p>
            </div>
            <div className="step-connector" />
            <div className="step-card">
              <div className="step-number">03</div>
              <h4>Earn Your Share</h4>
              <p>25% of all profits you generate are yours — paid out on the 15th and last day of each month.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Rules */}
      <section className="landing-section landing-section-dark">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">Platform Rules</h2>
          <p className="landing-section-sub">Understanding your obligations and protections</p>
          <div className="rules-grid">
            <div className="rule-card">
              <div className="rule-icon rule-icon-green">₹</div>
              <h4>Profit Sharing</h4>
              <p>
                You keep <strong>25% of net profits</strong> generated through your trades. There is no upfront fee
                or capital commitment required from you.
              </p>
            </div>
            <div className="rule-card">
              <div className="rule-icon rule-icon-red">!</div>
              <h4>Loss Limit & Reset</h4>
              <p>
                Each session has a maximum loss limit. If you hit it, <strong>all accumulated profits
                from previous days are forfeited</strong> and your account resets. Manage your risk carefully.
              </p>
            </div>
            <div className="rule-card">
              <div className="rule-icon rule-icon-blue">📅</div>
              <h4>Payout Schedule</h4>
              <p>
                Profit payouts are processed <strong>twice a month</strong> — on the <strong>15th</strong> and on
                the <strong>last day</strong> of each month. Earnings are calculated from confirmed closed trades.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Footer */}
      <section className="landing-cta-section">
        <h2>Ready to start trading?</h2>
        <p>Sign in with your Google account to get access.</p>
        <div className="landing-cta-btn">
          <GoogleLogin
            onSuccess={async (credentialResponse) => {
              try {
                await login(credentialResponse.credential!);
                navigate('/app/rules');
              } catch (e) {
                console.error('Login failed:', e);
              }
            }}
            onError={() => console.error('Google login error')}
          />
        </div>
      </section>

      <footer className="landing-footer">
        <span>© {new Date().getFullYear()} PropFirm Trading. All rights reserved.</span>
      </footer>
    </div>
  );
}
