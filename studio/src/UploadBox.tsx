import { useRef, useState } from 'react';
import { ACCEPTED_EXT, DEMO, MAX_UPLOAD_MB, formatLimit, uploadSlide } from './api';

interface Props {
  onUploaded: (path: string) => void;
  onError: (msg: string) => void;
  large?: boolean;
  /** Icon-only button (used while a slide is open) */
  compact?: boolean;
}

/** Shared upload logic: validates the file, uploads it, reports progress. */
function useSlideUpload(onUploaded: (path: string) => void, onError: (msg: string) => void) {
  const [progress, setProgress] = useState<number | null>(null);
  const [name, setName] = useState('');
  const send = async (file?: File) => {
    if (!file || progress !== null) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ACCEPTED_EXT.includes(ext)) return onError(`Unsupported file type .${ext}. Accepted: ${ACCEPTED_EXT.map(e => '.' + e).join(' ')}`);
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return onError(`File too large (limit ${formatLimit(MAX_UPLOAD_MB)})`);
    setName(file.name); setProgress(0);
    try { onUploaded((await uploadSlide(file, setProgress)).path); }
    catch (e) { onError((e as Error).message); }
    finally { setProgress(null); }
  };
  return { send, progress, name };
}

export default function UploadBox({ onUploaded, onError, large, compact }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const { send, progress, name } = useSlideUpload(onUploaded, onError);

  if (DEMO) {
    return <div className={`upload disabled ${large ? 'large' : ''}`}><strong>Upload a slide</strong><span>Not available in demo mode</span></div>;
  }

  if (compact) {
    return (
      <div className={`upload-compact ${drag ? 'drag' : ''}`}
           onDragOver={e => { e.preventDefault(); setDrag(true); }}
           onDragLeave={() => setDrag(false)}
           onDrop={e => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files?.[0]); }}>
        <button className="icon-btn" title={progress === null ? 'Upload a slide' : `Uploading ${name}…`} aria-label="Upload a slide"
                disabled={progress !== null} onClick={() => input.current?.click()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
          </svg>
        </button>
        {progress !== null && <div className="bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        <input ref={input} type="file" hidden accept={ACCEPTED_EXT.map(e => '.' + e).join(',')}
               onChange={e => { send(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    );
  }

  return (
    <div
      className={`upload ${large ? 'large' : ''} ${drag ? 'drag' : ''}`}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files?.[0]); }}
    >
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
      </svg>
      <strong>Upload your slide</strong>
      {progress === null ? (<>
        <span>Drag &amp; drop a file here, or</span>
        <button className="primary" onClick={() => input.current?.click()}>Choose a file</button>
        <small>{ACCEPTED_EXT.map(e => '.' + e).join(' ')} · up to {formatLimit(MAX_UPLOAD_MB)} · kept for this session only</small>
      </>) : (<>
        <span className="file">{name}</span>
        <div className="bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        <small>{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Checking slide…'}</small>
      </>)}
      <input ref={input} type="file" hidden accept={ACCEPTED_EXT.map(e => '.' + e).join(',')}
             onChange={e => { send(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}
