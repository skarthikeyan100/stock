import { ReactNode } from 'react';
import { Alert, Badge, Button, Container } from 'react-bootstrap';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';
import ThemeToggle from './ThemeToggle';

// Header + status banners shared by every contractor page.
export default function ContractorLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (!user) return null;
  const home = user.type === 'BUSINESS' ? '/my/recommend' : '/my/forecast';
  const doLogout = async () => {
    if (!window.confirm('If you log out you will need a NEW invitation from us to get back in (there is no login page). Log out?')) return;
    if (await logout()) navigate('/', { replace: true });
  };
  const statusBanner = (): ReactNode => {
    switch (user.status) {
      case 'INVITED': return <Alert variant="info" className="mb-3">Your account is waiting for activation. We will let you know once it is active.</Alert>;
      case 'AGREEMENT_PENDING': return <Alert variant="warning" className="mb-3">A new agreement (v{user.agreementVersionRequired}) is in force. Please read and accept it on your <Link to="/my/profile">profile</Link> to continue.</Alert>;
      case 'PAUSED': return <Alert variant="warning" className="mb-3">Your account is paused{user.statusReason ? `: ${user.statusReason}` : ''}.</Alert>;
      case 'PAUSED_INVOICE': return <Alert variant="warning" className="mb-3">Paused: an invoice is overdue. Upload it to continue.</Alert>;
      case 'TERMINATED': return <Alert variant="secondary" className="mb-3">This engagement has ended.</Alert>;
      default: return null;
    }
  };
  return (
    <>
      <div className="border-bottom py-2 mb-3">
        <Container className="d-flex align-items-center gap-3 flex-wrap">
          <span className="fw-bold">Nivedha Tech</span>
          <ThemeToggle />
          <nav className="d-flex gap-3 ms-2">
            <Link to={home} className={pathname === home ? 'fw-bold' : ''}>{user.type === 'BUSINESS' ? 'Recommendations' : 'Forecasts'}</Link>
            <Link to="/my/profile" className={pathname === '/my/profile' ? 'fw-bold' : ''}>Profile</Link>
          </nav>
          <div className="ms-auto d-flex align-items-center gap-2">
            {user.isTest && <Badge bg="warning" text="dark">TEST</Badge>}
            <span className="small">{user.name}</span>
            <NotificationBell />
            <Button size="sm" variant="outline-secondary" onClick={doLogout}>Log out</Button>
          </div>
        </Container>
      </div>
      <Container className="pb-5">
        {user.upcomingAgreement && <Alert variant="info" className="mb-3">A new agreement (v{user.upcomingAgreement.version}) takes effect on {user.upcomingAgreement.effectiveDate} ({user.upcomingAgreement.daysLeft} days). You will be asked to accept it.</Alert>}
        {statusBanner()}
        {children}
      </Container>
    </>
  );
}
