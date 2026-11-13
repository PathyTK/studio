// Saves annotations to the signed-in user's account and restores them after sign-in.
// Anonymous users never call this: their annotations stay in the browser tab.
import { Annotation, allSlidesWithAnnotations, clearAnnotations, getUpdatedAt, loadAnnotations, onAnnotationsSaved, saveAnnotations } from './storage';

export type SyncState = 'idle' | 'saving' | 'saved' | 'error';
let enabled = false;
let state: SyncState = 'idle';
const timers = new Map<string, number>();
const subs = new Set<(s: SyncState) => void>();
const setState = (s: SyncState) => { state = s; subs.forEach(f => f(s)); };
export const getSyncState = () => state;
export const onSyncState = (fn: (s: SyncState) => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

const headers = { 'Content-Type': 'application/json' };

async function push(slide: string) {
  const r = await fetch('/api/annotations', {
    method: 'PUT', credentials: 'same-origin', headers,
    body: JSON.stringify({ slide, annotations: loadAnnotations(slide), updatedAt: getUpdatedAt(slide) || Date.now() }),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
}

// Debounced: drawing or editing a shape saves about a second later.
onAnnotationsSaved(slide => {
  if (!enabled) return;
  clearTimeout(timers.get(slide));
  setState('saving');
  timers.set(slide, window.setTimeout(async () => {
    timers.delete(slide);
    try { await push(slide); if (!timers.size) setState('saved'); } catch { setState('error'); }
  }, 800));
});

/** Start saving to the account. Merges what the account has with what this tab has, newest copy per slide wins. */
export async function startSync(): Promise<{ pulled: number; pushed: number }> {
  enabled = true;
  const r = await fetch('/api/annotations', { credentials: 'same-origin' });
  if (!r.ok) { setState('error'); throw new Error(`restore failed (${r.status})`); }
  const server = (await r.json()).slides as Record<string, { annotations: Annotation[]; updatedAt: number }>;
  const local = new Set(allSlidesWithAnnotations());
  let pulled = 0, pushed = 0;
  try {
    for (const slide of new Set([...Object.keys(server), ...local])) {
      const s = server[slide];
      if (s && (!local.has(slide) || s.updatedAt >= getUpdatedAt(slide))) {
        saveAnnotations(slide, s.annotations, { silent: true, updatedAt: s.updatedAt }); pulled++;
      } else if (local.has(slide)) {
        await push(slide); pushed++; // e.g. shapes drawn before signing up become part of the account
      }
    }
    setState('saved');
  } catch (e) { setState('error'); throw e; }
  return { pulled, pushed };
}

/** Stop saving (signed out or session expired). */
export function stopSync() {
  enabled = false;
  timers.forEach(t => clearTimeout(t)); timers.clear();
  setState('idle');
}

/** Explicit sign-out: also forget this tab's copy; the account keeps its own. */
export function signOutCleanup() { stopSync(); clearAnnotations(); }
