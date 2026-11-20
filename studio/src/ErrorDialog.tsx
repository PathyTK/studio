import { useEffect, useRef } from 'react';

interface Props { message: string; onClose: () => void }

/** Error pop-up: centred, over a dimmed backdrop, dismissed by the button, a tap outside, or Escape. Big touch targets for tablets. */
export default function ErrorDialog({ message, onClose }: Props) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [message, onClose]);

  return (
    <div className="modal-backdrop error-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="err-title" aria-describedby="err-msg">
        <button className="modal-close" aria-label="Dismiss" onClick={onClose}>×</button>
        <div className="error-icon" aria-hidden>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 7v6M12 17h.01" /></svg>
        </div>
        <h2 id="err-title">Something went wrong</h2>
        <p id="err-msg">{message}</p>
        <button ref={btn} className="primary wide" onClick={onClose}>Dismiss</button>
      </div>
    </div>
  );
}
