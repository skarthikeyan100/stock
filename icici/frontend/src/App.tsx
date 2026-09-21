import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TradingProvider } from './context/TradingContext';
import { DemoTradingProvider } from './context/DemoTradingContext';
import LoginPage from './pages/LoginPage';
import RulesPage from './pages/RulesPage';
import TradingPage from './pages/TradingPage';
import DemoTradingPage from './pages/DemoTradingPage';
import AdminPage from './pages/AdminPage';
import ProfilePage from './pages/ProfilePage';
import { Spinner } from 'react-bootstrap';
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

export default function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LoginPage />} />
            <Route path="/rules" element={<RequireAuth><RulesPage /></RequireAuth>} />
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}
