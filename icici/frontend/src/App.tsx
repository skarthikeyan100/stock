import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TradingProvider } from './context/TradingContext';
import LoginPage from './pages/LoginPage';
import RulesPage from './pages/RulesPage';
import TradingPage from './pages/TradingPage';
import AdminPage from './pages/AdminPage';
import ProfilePage from './pages/ProfilePage';
import PayoutsPage from './pages/PayoutsPage';
import { Spinner } from 'react-bootstrap';
import './App.css';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { isLoggedIn, loading } = useAuth();
  if (loading) return <div className="d-flex justify-content-center align-items-center min-vh-100"><Spinner animation="border" /></div>;
  if (!isLoggedIn) return <Navigate to="/app" replace />;
  return children;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <div className="d-flex justify-content-center align-items-center min-vh-100"><Spinner animation="border" /></div>;
  if (!isAdmin) return <Navigate to="/app" replace />;
  return children;
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/app" element={<LoginPage />} />
            <Route path="/app/rules" element={<RequireAuth><RulesPage /></RequireAuth>} />
            <Route
              path="/app/trade"
              element={
                <RequireAuth>
                  <TradingProvider>
                    <TradingPage />
                  </TradingProvider>
                </RequireAuth>
              }
            />
            <Route path="/app/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
            <Route path="/app/payouts" element={<RequireAuth><PayoutsPage /></RequireAuth>} />
            <Route
              path="/app/admin"
              element={
                <RequireAdmin>
                  <AdminPage />
                </RequireAdmin>
              }
            />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}
