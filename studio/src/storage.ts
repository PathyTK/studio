// Annotations live in sessionStorage: closing the tab ends the session. Signed-in users also get them
// saved to their account (see sync.ts); a share link (share.ts) can carry them to someone else.
const PREFIX = 'pathy:annotations:';
const META = 'pathy:annotations-meta:'; // when each slide's annotations last changed (ms): decides which copy wins on sync
const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export type Annotation = { id: string; [k: string]: unknown };

type Listener = (slide: string, annotations: Annotation[]) => void;
const listeners = new Set<Listener>();
/** Called after every local change (not for silent writes such as pulling from the server). */
export const onAnnotationsSaved = (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const loadAnnotations = (slide: string): Annotation[] =>
  safe(() => JSON.parse(sessionStorage.getItem(PREFIX + slide) ?? '[]'), []);

export const getUpdatedAt = (slide: string): number =>
  safe(() => Number(sessionStorage.getItem(META + slide)) || 0, 0);

export const saveAnnotations = (slide: string, a: Annotation[], opts: { silent?: boolean; updatedAt?: number } = {}) => {
  safe(() => {
    if (a.length) sessionStorage.setItem(PREFIX + slide, JSON.stringify(a)); else sessionStorage.removeItem(PREFIX + slide);
    sessionStorage.setItem(META + slide, String(opts.updatedAt ?? Date.now()));
  }, undefined);
  if (!opts.silent) listeners.forEach(fn => fn(slide, a));
};

export const allSlidesWithAnnotations = (): string[] =>
  safe(() => Object.keys(sessionStorage).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)), []);

/** Forget everything from this tab (used on sign-out so the next person on this computer doesn't see it). */
export const clearAnnotations = () =>
  safe(() => Object.keys(sessionStorage).filter(k => k.startsWith(PREFIX) || k.startsWith(META)).forEach(k => sessionStorage.removeItem(k)), undefined);

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
