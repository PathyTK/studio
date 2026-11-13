import { useEffect, useRef, useState } from 'react';
import { ApiError, ChatMessage, streamChat } from './auth';
import type { ChatContext } from './auth';

interface Props {
  slideName: string;
  hasSelection: boolean;
  badge: string | null; // 'mock' or the local model's name; nothing for the real provider
  dailyLimit: number;
  getContext: () => ChatContext; // fresh screenshot + selected annotation, taken when you send
  onClose: () => void;
  onSignedOut: () => void;
}

const CONSENT_KEY = 'pathy:ai-consent';
const QUICK = [
  { label: 'Identify the organ', q: 'Which organ or tissue is this? Rank the most likely candidates and explain the features that support each.' },
  { label: 'Describe this view', q: 'Describe what you see in this view: architecture, cell types, staining and any artefacts.' },
  { label: 'Opinion on my annotation', q: 'What is your opinion on the annotated region? Describe it and what it could represent.', needsSelection: true },
];

export default function AiPanel({ slideName, hasSelection, badge, dailyLimit, getContext, onClose, onSignedOut }: Props) {
  const [consent, setConsent] = useState(() => { try { return sessionStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; } });
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [left, setLeft] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { setMsgs([]); setError(''); }, [slideName]); // a conversation belongs to one slide

  const send = async (text: string) => {
    text = text.trim();
    if (!text || busy) return;
    const history: ChatMessage[] = [...msgs, { role: 'user', content: text }];
    setMsgs([...history, { role: 'assistant', content: '' }]);
    setInput(''); setError(''); setBusy(true);
    abort.current = new AbortController();
    try {
      const rest = await streamChat(history.slice(-12), getContext(), chunk =>
        setMsgs(m => { const c = m.slice(); c[c.length - 1] = { role: 'assistant', content: c[c.length - 1].content + chunk }; return c; }), abort.current.signal);
      if (rest !== null) setLeft(rest);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      const ae = e as ApiError;
      setMsgs(m => (m[m.length - 1]?.content === '' ? m.slice(0, -1) : m));
      setError(ae.message);
      if (ae.status === 401) onSignedOut();
    } finally { setBusy(false); }
  };

  return (
    <aside className="ai-panel" aria-label="AI assistant">
      <header>
        <strong>Pathy AI</strong>{badge && <span className="badge" title="Test setup: not the production model">{badge}</span>}
        <span className="spacer" />
        <button className="x" aria-label="Close AI panel" onClick={onClose}>×</button>
      </header>
      {!consent ? (
        <div className="ai-body">
          <p><strong>Before you start</strong></p>
          <ul>
            <li>Your current view (and a close-up of a selected annotation) is sent to an AI provider to produce answers.</li>
            <li>Do not use slides that contain patient-identifiable information.</li>
            <li>Answers are for education and research. They are not a diagnosis; a pathologist must confirm any finding.</li>
          </ul>
          <button className="primary wide" onClick={() => { try { sessionStorage.setItem(CONSENT_KEY, '1'); } catch { /* ignore */ } setConsent(true); }}>I understand</button>
        </div>
      ) : (<>
        <div className="ai-body msgs">
          {msgs.length === 0 && (
            <div className="muted intro">
              Ask about <strong>{slideName}</strong>. The AI sees what is on your screen right now, so zoom to the area you care about first.
              {hasSelection && <div className="attached">An annotation is selected: it will be sent along.</div>}
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>{m.content || (busy && i === msgs.length - 1 ? <span className="dots">thinking</span> : '')}</div>
          ))}
          {error && <div className="err">{error}</div>}
          <div ref={end} />
        </div>
        <div className="quick">
          {QUICK.map(c => (
            <button key={c.label} disabled={busy || (c.needsSelection && !hasSelection)} onClick={() => send(c.q)}
                    title={c.needsSelection && !hasSelection ? 'Select an annotation first' : undefined}>{c.label}</button>
          ))}
        </div>
        <form className="ai-input" onSubmit={e => { e.preventDefault(); send(input); }}>
          <textarea value={input} rows={2} maxLength={4000} placeholder="Ask about this slide…" disabled={busy}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }} />
          <button className="primary" disabled={busy || !input.trim()}>Send</button>
        </form>
        <div className="muted foot">{left !== null ? `${left} of ${dailyLimit} messages left today` : `${dailyLimit} messages per day`} · not a diagnosis</div>
      </>)}
    </aside>
  );
}
