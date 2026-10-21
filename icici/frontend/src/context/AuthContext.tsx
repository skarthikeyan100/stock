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
  allottedCapital?: number;
  targetPoints?: number;
  stopLossPoints?: number;
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
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  isLoggedIn: boolean;
  isAdmin: boolean;
  termsAccepted: boolean;
  login: (credential: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setTermsAccepted: (accepted: boolean) => void;
}

const AuthContext = createContext<AuthState | null>(null);

// Rules-page acceptance is remembered client-side only (no backend field) -
// keyed per email in localStorage, since the same browser/device can see
// more than one account log in over time. Read/write both wrapped in
// try/catch: private-browsing/blocked-storage/quota failures must fall back
// to "not accepted yet" (asks again) rather than throwing and breaking login.
const TERMS_KEY_PREFIX = 'propfirm.termsAccepted.';

function termsKeyFor(email: string): string {
  return `${TERMS_KEY_PREFIX}${email}`;
}

function readTermsAccepted(email: string): boolean {
  try {
    return localStorage.getItem(termsKeyFor(email)) === 'true';
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [termsAccepted, setTermsAcceptedState] = useState(false);

  // Check session on mount
  useEffect(() => {
    fetch('/auth/me')
      .then(res => {
        if (res.ok) return res.json();
        throw new Error('Not logged in');
      })
      .then(data => {
        // Set together with `user`, in the same state update, so there is
        // never a render where isLoggedIn is true but termsAccepted hasn't
        // caught up yet - that gap would let LoginPage's redirect effect
        // bounce an already-accepted returning user through /rules for one
        // frame before snapping back.
        setUser(data);
        setTermsAcceptedState(readTermsAccepted(data.email));
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (credential: string) => {
    // The raw Google ID token is sent as-is - the server verifies it
    // (google-auth-library's verifyIdToken) and derives email/name/picture
    // from the verified payload itself, rather than trusting client-decoded
    // fields (which anyone could forge with an unsigned POST).
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) throw new Error('Login failed');
    const userData = await res.json();
    setUser(userData);
    setTermsAcceptedState(readTermsAccepted(userData.email)); // see the mount effect's comment above
  }, []);

  const logout = useCallback(async () => {
    await fetch('/auth/logout', { method: 'POST' });
    setUser(null);
    setTermsAcceptedState(false); // in-memory reset only - the persisted per-email acceptance is left intact for next login
  }, []);

  // Exposed as `setTermsAccepted` below - persists the acceptance so it
  // isn't asked again on this device for this account (the actual feature
  // requested: accept once, never see /rules again on a later login).
  const setTermsAccepted = useCallback((accepted: boolean) => {
    setTermsAcceptedState(accepted);
    if (!user) return; // shouldn't happen (RulesPage requires being logged in) - defensive only
    try {
      if (accepted) localStorage.setItem(termsKeyFor(user.email), 'true');
      else localStorage.removeItem(termsKeyFor(user.email));
    } catch {
      // Storage blocked/unavailable - in-memory state above still updates for this session;
      // it just won't survive a reload or next login, which degrades safely to "ask again"
      // rather than failing the accept action itself.
    }
  }, [user]);

  // Re-fetches the session user - used after a background update (e.g. OCR
  // extracting a PAN/Aadhaar number from an uploaded document) so the UI
  // reflects it without requiring a full re-login.
  const refreshUser = useCallback(async () => {
    const res = await fetch('/auth/me');
    if (res.ok) setUser(await res.json());
  }, []);

  const isLoggedIn = !!user;
  const isAdmin = user?.role === 'admin';

  return (
    <AuthContext.Provider value={{ user, loading, isLoggedIn, isAdmin, termsAccepted, login, logout, refreshUser, setTermsAccepted }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
