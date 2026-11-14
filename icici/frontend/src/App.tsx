import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TradingProvider } from './context/TradingContext';
import { DemoTradingProvider } from './context/DemoTradingContext';
import { ThemeProvider } from './context/ThemeContext';
import LoginPage from './pages/LoginPage';
import RulesPage from './pages/RulesPage';
import LevelsPage from './pages/LevelsPage';
import TradingPage from './pages/TradingPage';
import DemoTradingPage from './pages/DemoTradingPage';
import AdminPage from './pages/AdminPage';
import PayoutPaymentPage from './pages/PayoutPaymentPage';
import ProfilePage from './pages/ProfilePage';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import TermsAndConditionsPage from './pages/TermsAndConditionsPage';
import { Spinner, Button } from 'react-bootstrap';
import { apiFetch } from './utils/api';
import './App.css';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { isLoggedIn, loading } = useAuth();
  if (loading) return <div className="d-flex justify-content-center align-items-center min-vh-100"><Spinner animation="border" /></div>;
  if (!isLoggedIn) return <Navigate to="/" replace />;
  return children;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <div className="d-flex justify-content-center align-items-center min-vh-100"><Spinner animation="border" /></div>;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

// Shown on every page while an admin is using the app as another user.
function ActingAsBanner() {
  const { user } = useAuth();
  if (!user?.actingAs) return null;
  const exit = async () => {
    try { await apiFetch('/act-as/stop', { method: 'POST' }); } catch { /* the reload below shows the real state either way */ }
    window.location.assign('/admin');
  };
  return (
    <div className="bg-warning text-dark px-3 py-2 d-flex align-items-center justify-content-center gap-3 flex-wrap" style={{ position: 'sticky', top: 0, zIndex: 2000 }}>
      <span>
        <strong>You are using the app as {user.name} ({user.email}).</strong> Orders you place are real and are mirrored as usual.
      </span>
      <Button size="sm" variant="dark" onClick={exit}>Exit</Button>
    </div>
  );
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            <ActingAsBanner />
            <Routes>
              <Route path="/" element={<LoginPage />} />
              <Route path="/rules" element={<RequireAuth><RulesPage /></RequireAuth>} />
              <Route path="/levels" element={<LevelsPage />} />
              <Route
                path="/trade"
                element={
                  <RequireAuth>
                    <TradingProvider>
                      <TradingPage />
                    </TradingProvider>
                  </RequireAuth>
                }
              />
              <Route
                path="/demo"
                element={
                  <DemoTradingProvider>
                    <DemoTradingPage />
                  </DemoTradingProvider>
                }
              />
              <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
              <Route
                path="/admin"
                element={
                  <RequireAdmin>
                    <AdminPage />
                  </RequireAdmin>
                }
              />
              <Route path="/admin/payouts/:id" element={<RequireAdmin><PayoutPaymentPage /></RequireAdmin>} />
              <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
              <Route path="/terms-and-conditions" element={<TermsAndConditionsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </GoogleOAuthProvider>
  );
}
