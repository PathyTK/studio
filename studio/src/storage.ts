// Everything lives in sessionStorage: closing the tab ends the session. A share link (see share.ts) carries it to someone else.
const PREFIX = 'pathy:annotations:';
const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export type Annotation = { id: string; [k: string]: unknown };

export const loadAnnotations = (slide: string): Annotation[] =>
  safe(() => JSON.parse(sessionStorage.getItem(PREFIX + slide) ?? '[]'), []);

export const saveAnnotations = (slide: string, a: Annotation[]) =>
  safe(() => sessionStorage.setItem(PREFIX + slide, JSON.stringify(a)), undefined);

export const allSlidesWithAnnotations = (): string[] =>
  safe(() => Object.keys(sessionStorage).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)), []);

export type SessionData = Record<string, Annotation[]>;

/** Annotations of every slide in this session, keyed by slide path. */
export const collectSession = (): SessionData => {
  const data: SessionData = {};
  allSlidesWithAnnotations().forEach(s => (data[s] = loadAnnotations(s)));
  return data;
};

/** Loads shared annotations into this session (replaces the same slides' annotations). */
export const mergeSession = (data: SessionData) =>
  Object.entries(data).forEach(([slide, a]) => Array.isArray(a) && saveAnnotations(slide, a));
