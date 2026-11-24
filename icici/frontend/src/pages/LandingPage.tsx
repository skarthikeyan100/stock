import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';

// The public page: no sign-up, no sign-in, no marketing (spec v2.1 sections 3 and 13). Access is by an invitation link only.
export default function LandingPage() {
  const { isLoggedIn, isContractor, loading } = useAuth();
  if (!loading && isLoggedIn) return <Navigate to={isContractor ? '/my' : '/trade'} replace />;
  return (
    <div className="landing-page d-flex flex-column min-vh-100">
      <nav className="landing-nav">
        <div className="d-flex align-items-center gap-3">
          <span className="landing-nav-brand">Nivedha Tech</span>
          <ThemeToggle />
        </div>
      </nav>
      <main className="flex-grow-1 d-flex flex-column justify-content-center align-items-center text-center px-3">
        <h1 className="h3 mb-3">Nivedha Tech – Research Portal</h1>
        <p className="lead mb-4">Private research programme. By invitation only.</p>
        <p className="mb-0">
          Contact: <a href="mailto:admin@nivedhatech.com">admin@nivedhatech.com</a>
        </p>
      </main>
      <footer className="text-center small py-3 opacity-75">
        <a href="/privacy-policy">Privacy Policy</a>
      </footer>
    </div>
  );
}
