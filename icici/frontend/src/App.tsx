import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TradingProvider } from './context/TradingContext';
import { ThemeProvider } from './context/ThemeContext';
const TradingPage = lazy(() => import('./pages/TradingPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const PayoutPaymentPage = lazy(() => import('./pages/PayoutPaymentPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const PrivacyNoticePage = lazy(() => import('./pages/PrivacyNoticePage'));
import LandingPage from './pages/LandingPage';
import OwnerLoginPage from './pages/OwnerLoginPage';
import JoinPage from './pages/JoinPage';
import RecommendPage from './pages/RecommendPage';
import ForecastPage from './pages/ForecastPage';
import MyProfilePage from './pages/MyProfilePage';
const OwnerPage = lazy(() => import('./pages/OwnerPage'));
import ApprovalPopup, { OwnerConsoleLink } from './components/ApprovalPopup';
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

function RequireContractor({ children }: { children: React.ReactElement }) {
  const { isContractor, loading } = useAuth();
  if (loading) return <div className="d-flex justify-content-center align-items-center min-vh-100"><Spinner animation="border" /></div>;
  if (!isContractor) return <Navigate to="/" replace />;
  return children;
}

// /my: a contractor's home depends on their agreement type (Individual forecasts, Business recommends).
function ContractorHome() {
  const { user, isContractor, loading } = useAuth();
  if (loading) return <div className="d-flex justify-content-center align-items-center min-vh-100"><Spinner animation="border" /></div>;
  if (!isContractor) return <Navigate to="/" replace />;
  return <Navigate to={user?.type === 'BUSINESS' ? '/my/recommend' : '/my/forecast'} replace />;
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
            <ApprovalPopup />
            <OwnerConsoleLink />
            {/* The trading, admin, owner and profile pages are separate chunks: a contractor never downloads them (and scripts/check-contractor-bundle.js scans only what a contractor can load). */}
            <Suspense fallback={<div className="d-flex justify-content-center align-items-center min-vh-100"><Spinner animation="border" /></div>}>
            <Routes>
              {/* Invitation-only: the public page has no sign-in. The owner signs in at the unlinked /owner-login; contractors enter through /join/:token. */}
              <Route path="/" element={<LandingPage />} />
              <Route path="/owner-login" element={<OwnerLoginPage />} />
              <Route path="/join/:token" element={<JoinPage />} />
              <Route path="/my" element={<ContractorHome />} />
              <Route path="/my/forecast" element={<RequireContractor><ForecastPage /></RequireContractor>} />
              <Route path="/my/recommend" element={<RequireContractor><RecommendPage /></RequireContractor>} />
              <Route path="/my/profile" element={<RequireContractor><MyProfilePage /></RequireContractor>} />
              <Route path="/console" element={<RequireAdmin><OwnerPage /></RequireAdmin>} />
              <Route path="/rules" element={<Navigate to="/" replace />} />
              <Route path="/levels" element={<Navigate to="/" replace />} />
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
              <Route path="/demo" element={<Navigate to="/" replace />} />
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
              <Route path="/privacy-policy" element={<PrivacyNoticePage />} />
              <Route path="/terms-and-conditions" element={<Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </GoogleOAuthProvider>
  );
}
