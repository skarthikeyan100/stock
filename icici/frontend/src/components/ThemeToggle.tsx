import { Button } from 'react-bootstrap';
import { useTheme } from '../context/ThemeContext';

// Small header button that flips light/dark. The choice is remembered in the browser (see ThemeContext).
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Button variant="outline-secondary" size="sm" onClick={toggleTheme} aria-label={label} title={label}>
      {theme === 'dark' ? '☀' : '☾'}
    </Button>
  );
}
