import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { apiFetch, setUnauthorizedHandler } from '../utils/api';

export interface AuthUser {
  email: string;
  name: string;
  picture: string;
  lossLimit: number;
  // Canonical names (lotLimit / accountCapital / strategyCapital); the server still sends the old ones too during the migration.
  lotLimit: number;
  /** @deprecated use lotLimit */
  lotCount?: number;
  accountCapital: number;
  /** @deprecated use accountCapital */
  investmentAmount?: number;
  investmentMode: 'lotCount' | 'investmentAmount';
  investmentModeLocked?: boolean;
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
  strategyCapital?: number;
  /** @deprecated use strategyCapital */
  allottedCapital?: number;
  targetPoints?: number;
  stopLossPoints?: number;
  /** Platform defaults used when targetPoints / stopLossPoints are unset (from config.yml). */
  /** Set while an admin is using the app as this user (from /auth/me). */
  actingAs?: { admin: string; adminName?: string };
  defaultTargetPoints?: number;
  defaultStopLossPoints?: number;
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
  /** 'beginner' when absent. Advanced is permanent (server-enforced). */
  proficiencyLevel?: 'beginner' | 'advanced';
  advancedSince?: string;
  advancedVia?: 'admin' | 'gstin';
  accountClosed?: boolean;
  // Contractor portal (/auth/me answers a contractor with this contractor-safe view; none of the trading fields above are present for them).
  type?: 'INDIVIDUAL' | 'BUSINESS';
  level?: 'beginner' | 'advanced';
  status?: 'INVITED' | 'AGREEMENT_PENDING' | 'ACTIVE' | 'PAUSED' | 'PAUSED_INVOICE' | 'TERMINATED';
  statusReason?: string;
  isTest?: boolean;
  agreementVersion?: string;
  agreementVersionRequired?: string;
  upcomingAgreement?: { version: string; effectiveDate: string; daysLeft: number } | null;
  blockedReason?: string | null;
  kyc?: Record<string, any> | null;
  sebi?: { number: string; validUntil: string; verified: boolean } | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  isLoggedIn: boolean;
  isAdmin: boolean;
  isContractor: boolean;
  termsAccepted: boolean;
  /** Resolves to whether this account has already accepted the rules (then the Rules screen is skipped). */
  login: (credential: string) => Promise<boolean>;
  logout: () => Promise<boolean>;
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
    apiFetch('/auth/me')
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
    const res = await apiFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) throw new Error('Login failed');
    const userData = await res.json();
    setUser(userData);
    const accepted = readTermsAccepted(userData.email);
    setTermsAcceptedState(accepted); // see the mount effect's comment above
    return accepted;
  }, []);

  // Any 401 from the API (other than /auth/*) means the session is gone: show the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => { setUser(null); setTermsAcceptedState(false); });
    return () => setUnauthorizedHandler(null);
  }, []);

  const logout = useCallback(async () => {
    // Only treat the user as logged out once the server confirms: clearing the UI while the cookie stays valid (a failed or
    // non-OK logout) would show a login screen over a session that is still live.
    try {
      const res = await apiFetch('/auth/logout', { method: 'POST' });
      if (!res.ok) throw new Error(`Logout failed (${res.status})`);
    } catch (e) {
      console.error('[auth] logout failed - staying logged in:', e);
      return false;
    }
    setUser(null);
    setTermsAcceptedState(false); // in-memory reset only - the persisted per-email acceptance is left intact for next login
    return true;
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
    const res = await apiFetch('/auth/me');
    if (res.ok) setUser(await res.json());
  }, []);

  const isLoggedIn = !!user;
  const isAdmin = user?.role === 'admin';
  const isContractor = user?.role === 'contractor';

  return (
    <AuthContext.Provider value={{ user, loading, isLoggedIn, isAdmin, isContractor, termsAccepted, login, logout, refreshUser, setTermsAccepted }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
