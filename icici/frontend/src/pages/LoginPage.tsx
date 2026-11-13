import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import ThemeToggle from '../components/ThemeToggle';
import { useServerReachable } from '../utils/useServerReachable';

type LoginSlot = 'nav' | 'hero' | 'footer';

export default function LoginPage() {
  const { login, isLoggedIn, termsAccepted } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const serverUp = useServerReachable(); // Google sign-in is offered only if the trading server answered at page load
  const [loginError, setLoginError] = useState<{ message: string; where: LoginSlot } | null>(null);

  // Google's button is drawn on the opposite tone of the page so it stands out: a dark button on the light theme,
  // a light (outline) button on the dark theme. The theme prop re-renders the button when the user toggles.
  const googleTheme = theme === 'dark' ? 'outline' : 'filled_black';

  useEffect(() => {
    if (isLoggedIn && !termsAccepted) navigate('/rules', { replace: true });
  }, [isLoggedIn, termsAccepted, navigate]);

  // One handler pair for every Google button (nav, hero and footer). /rules forwards a user who has already accepted the terms.
  const onGoogleSuccess = (where: LoginSlot) => async (credentialResponse: CredentialResponse) => {
    setLoginError(null);
    try {
      if (!credentialResponse.credential) throw new Error('Google did not return a credential');
      await login(credentialResponse.credential);
      navigate('/rules');
    } catch (e: any) {
      console.error('Login failed:', e);
      setLoginError({ message: e?.message || 'Login failed - please try again', where });
    }
  };
  const onGoogleError = (where: LoginSlot) => () => setLoginError({ message: 'Google sign-in failed - please try again', where });

  return (
    <div className="landing-page">
      {/* Nav: theme toggle on the left (same side as the trading and profile headers), sign-in on the right */}
      <nav className="landing-nav">
        <div className="d-flex align-items-center gap-3">
          <span className="landing-nav-brand">PropFirm</span>
          <ThemeToggle />
        </div>
        <div className="landing-nav-signin d-flex align-items-center gap-3">
          {/* Works with the server down too: the demo replays a recorded day from /demo-ticks.csv in the browser */}
          <span
            role="button"
            className="landing-nav-demo"
            style={{ cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => navigate('/demo')}
          >
            Try Demo
          </span>
          <div className="position-relative">
            {serverUp && (
              <GoogleLogin
                onSuccess={onGoogleSuccess('nav')}
                onError={onGoogleError('nav')}
                theme={googleTheme}
                size="medium"
              />
            )}
            {loginError?.where === 'nav' && (
              <div className="text-danger small position-absolute end-0" style={{ whiteSpace: 'nowrap' }}>{loginError.message}</div>
            )}
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-hero-content">
          <div className="landing-badge">Options Trading</div>
          <h1 className="landing-title">
            Trade Smarter.<br />
            <span className="landing-title-accent">Share the Profits.</span>
          </h1>
          <p className="landing-subtitle">
            Join our proprietary trading platform. We provide the capital —
            you bring the skill. Keep 40% of every rupee you earn.
          </p>
          <div className="landing-hero-cta">
            {serverUp && <GoogleLogin onSuccess={onGoogleSuccess('hero')} onError={onGoogleError('hero')} theme={googleTheme} />}
            {loginError?.where === 'hero' && <div className="text-danger small mt-2">{loginError.message}</div>}
          </div>
        </div>
        <div className="landing-hero-graphic">
          <div className="stat-card stat-card-1">
            <div className="stat-value text-success">+40%</div>
            <div className="stat-label">Your Profit Share</div>
          </div>
          <div className="stat-card stat-card-2">
            <div className="stat-value">Once a Week</div>
            <div className="stat-label">Payout Schedule</div>
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
              <p>40% of all profits you generate are yours — paid out every Wednesday.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Rules: first, because accepting them is the first step after sign-in */}
      <section className="landing-section landing-section-dark">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">Platform Rules</h2>
          <p className="landing-section-sub">Understanding your obligations and protections</p>
          <p className="text-center mb-4" style={{ color: 'var(--landing-muted)' }}>
            <strong style={{ color: 'var(--landing-strong)' }}>Trading week:</strong> runs from Wednesday to Tuesday.
            The weekly loss limit below is measured over one trading week.
          </p>
          <div className="rules-grid">
            <div className="rule-card">
              <div className="rule-icon rule-icon-green">₹</div>
              <h4>Profit Sharing</h4>
              <p>
                You keep <strong>40% of net profits</strong> generated through your trades. There is no upfront fee
                or capital commitment required from you.
              </p>
            </div>
            <div className="rule-card">
              <div className="rule-icon rule-icon-red">!</div>
              <h4>Loss Limit & Reset</h4>
              <p>
                Your realized loss on any single day may not exceed <strong>25% of your allocated capital</strong> —
                breach it and your positions are squared off, trading is paused until the next trading day, and
                <strong>all profits accumulated since your last payout are forfeited</strong>, even if you had made
                100% profit before that day. Your realized loss across a trading week (Wednesday–Tuesday)
                may not exceed <strong>50%</strong> — breach this weekly limit and <strong>your account will be
                closed</strong>. Manage your risk carefully.
              </p>
            </div>
            <div className="rule-card">
              <div className="rule-icon rule-icon-blue">📅</div>
              <h4>Payout Schedule</h4>
              <p>
                Payouts are processed <strong>every Wednesday</strong>.
                Earnings are calculated from all confirmed closed trades since the previous payout.
              </p>
              <p className="mt-2">
                To receive payouts, provide either your <strong>PAN number</strong> or your <strong>GSTIN</strong> in your profile.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Profit Scenarios */}
      <section className="landing-section">
        <div className="landing-section-inner">
          <h2 className="landing-section-title">How Profits & Losses Work</h2>
          <p className="landing-section-sub">Two scenarios — choose which side you want to be on</p>
          <div className="rules-grid">
            <div className="rule-card rule-card-success">
              <div className="rule-icon rule-icon-green">✓</div>
              <h4>Scenario A — You Profit</h4>
              <p>
                You trade carefully and close the week with <strong>₹40,000 in net profits</strong>.
                Your 40% share is <strong>₹16,000 paid directly to you</strong> on the next payout date.
                The firm keeps the rest and your account continues with full capital for next week.
              </p>
            </div>
            <div className="rule-card rule-card-danger">
              <div className="rule-icon rule-icon-red">✗</div>
              <h4>Scenario B — Profits Forfeited</h4>
              <p>
                You had ₹30,000 in accumulated profits, but a bad day breaches the 25% daily
                loss limit. <strong> All profits accumulated since your last payout are forfeited</strong> —
                you receive nothing for that period, even if you had made 100% profit before that day.
                <strong> Protect your gains. Never let a bad day erase your accumulated profits.</strong>
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
          {serverUp && <GoogleLogin onSuccess={onGoogleSuccess('footer')} onError={onGoogleError('footer')} theme={googleTheme} />}
          {loginError?.where === 'footer' && <div className="text-danger small mt-2">{loginError.message}</div>}
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-content">
          <span>© {new Date().getFullYear()} PropFirm Trading. All rights reserved.</span>
          <div className="landing-footer-links">
            <a href="/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
            <span className="divider">•</span>
            <a href="/terms-and-conditions" target="_blank" rel="noopener noreferrer">Terms & Conditions</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
