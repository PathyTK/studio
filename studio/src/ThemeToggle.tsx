import { Theme } from './theme';

// Two-icon pill (sun | moon), same look as pathy-web's theme toggle. Icons are lucide's Sun and Moon.
const Sun = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);
const Moon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);

export default function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="theme-toggle" role="group" aria-label="Switch theme">
      <button className={theme === 'light' ? 'on' : ''} aria-label="Light mode" aria-pressed={theme === 'light'} onClick={() => onChange('light')}><Sun /></button>
      <button className={theme === 'dark' ? 'on' : ''} aria-label="Dark mode" aria-pressed={theme === 'dark'} onClick={() => onChange('dark')}><Moon /></button>
    </div>
  );
}
