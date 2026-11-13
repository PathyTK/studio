// Same convention as pathy-web: tokens.css switches on the `theme-dark` class on <html>.
// Preference lives in sessionStorage (session-only app); default follows the OS.
const KEY = 'pathy:theme';
export type Theme = 'light' | 'dark';

export const initialTheme = (): Theme => {
  const q = new URLSearchParams(location.search).get('theme'); // ?theme=dark|light overrides
  if (q === 'light' || q === 'dark') return q;
  try { const t = sessionStorage.getItem(KEY); if (t === 'light' || t === 'dark') return t; } catch { /* ignore */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const applyTheme = (t: Theme) => {
  document.documentElement.classList.toggle('theme-dark', t === 'dark');
  try { sessionStorage.setItem(KEY, t); } catch { /* ignore */ }
};
