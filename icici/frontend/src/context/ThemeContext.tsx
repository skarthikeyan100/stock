import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

// Light/dark theme. Two inputs decide it:
//  1. an EXPLICIT choice: stored in localStorage['theme'] ONLY when the user clicks the toggle
//     (nothing is ever written on load, so a stored value is always a real choice); it wins on every page.
//  2. otherwise the per-page DEFAULT from defaultThemeForPath(): dark for the landing/login page ('/')
//     and the public legal pages, light for every logged-in app page (/trade, /demo, /rules,
//     /profile, /admin...). The OS prefers-color-scheme is no longer used.
// The attribute on <html> drives Bootstrap 5.3's own colour variables plus the app's
// [data-bs-theme="dark"] overrides in App.css. index.html sets the same attribute before React
// loads using the same rule, so the first paint already has the right theme. Keep both in sync.

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';

const DARK_DEFAULT_PATHS = ['/', '/privacy-policy', '/terms-and-conditions'];

export function defaultThemeForPath(pathname: string): Theme {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return DARK_DEFAULT_PATHS.includes(p) ? 'dark' : 'light';
}

function readSaved(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // storage blocked: fall back to the page default
  }
}

function saveChoice(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the choice still applies for this visit, it just is not remembered.
  }
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation(); // ThemeProvider must be inside the router
  const [explicit, setExplicit] = useState<Theme | null>(readSaved);
  const theme: Theme = explicit ?? defaultThemeForPath(pathname);

  useEffect(() => {
    document.documentElement.setAttribute('data-bs-theme', theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    saveChoice(next);
    setExplicit(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
