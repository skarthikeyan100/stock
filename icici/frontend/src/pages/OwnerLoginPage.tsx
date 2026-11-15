import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';
import { useServerReachable } from '../utils/useServerReachable';

// Not linked from anywhere: the owner/admin signs in with Google here. The server accepts admin accounts only; contractors have no login.
export default function OwnerLoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const serverUp = useServerReachable();
  const [error, setError] = useState('');
  const onSuccess = async (r: CredentialResponse) => {
    setError('');
    try {
      if (!r.credential) throw new Error('Google did not return a credential');
      await login(r.credential);
      navigate('/trade');
    } catch {
      setError('Sign-in was refused.');
    }
  };
  return (
    <div className="d-flex flex-column justify-content-center align-items-center min-vh-100 gap-3">
      <h1 className="h5">Owner sign-in</h1>
      {serverUp ? <GoogleLogin onSuccess={onSuccess} onError={() => setError('Google sign-in failed')} /> : <div className="text-muted">The server is not reachable.</div>}
      {error && <div className="text-danger small">{error}</div>}
    </div>
  );
}
