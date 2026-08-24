import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

export interface AuthUser {
  email: string;
  name: string;
  picture: string;
  lossLimit: number;
  lotCount: number;
  investmentAmount: number;
  investmentMode: 'lotCount' | 'investmentAmount';
  useGTT: boolean;
  role: string;
  enabled: boolean;
  phone?: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  addressProofId?: string;
  dobProofId?: string;
  panCardId?: string;
  addressVerified: boolean;
  dobVerified: boolean;
  panVerified: boolean;
  perOrderCap?: number;
  legalName?: string;
  aadharDocId?: string;
  aadharVerified: boolean;
  // Server never echoes raw KYC numbers/bank account numbers back - only
  // masked variants, computed by user.ts's toClientUser.
  aadharNumberMasked?: string;
  panNumberMasked?: string;
  profitSplitPercent: number;
  bankAccountHolderName?: string;
  bankAccountNumberMasked?: string;
  bankIFSC?: string;
  upiId?: string;
  entityType: 'individual' | 'company';
  gstin?: string;
  gstDocId?: string;
  gstVerified: boolean;
  companyRegisteredName?: string;
  companyRegisteredAddress?: string;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  isLoggedIn: boolean;
  isAdmin: boolean;
  login: (credential: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Check session on mount
  useEffect(() => {
    fetch('/auth/me')
      .then(res => {
        if (res.ok) return res.json();
        throw new Error('Not logged in');
      })
      .then(data => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (credential: string) => {
    // Decode Google JWT payload to extract email, name, picture
    const payload = JSON.parse(atob(credential.split('.')[1]));
    const { email, name, picture } = payload;

    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, picture }),
    });
    if (!res.ok) throw new Error('Login failed');
    const userData = await res.json();
    setUser(userData);
  }, []);

  const logout = useCallback(async () => {
    await fetch('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const isLoggedIn = !!user;
  const isAdmin = user?.role === 'admin';

  return (
    <AuthContext.Provider value={{ user, loading, isLoggedIn, isAdmin, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
