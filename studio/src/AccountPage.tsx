import { SlideEntry } from './api';
import { allSlidesWithAnnotations, loadAnnotations } from './storage';
import type { User } from './auth';

interface Props { user: User; slides: SlideEntry[]; onBack: () => void; onSignOut: () => void }

/** Account overview: who you are, how many slides and annotations you keep. */
export default function AccountPage({ user, slides, onBack, onSignOut }: Props) {
  const mine = slides.filter(s => s.scope === 'mine');
  const annotated = allSlidesWithAnnotations();
  const annotations = annotated.reduce((n, p) => n + loadAnnotations(p).length, 0);
  const display = user.name || user.email;

  return (
    <div className="account-page">
      <div className="account-card">
        <button className="link back" onClick={onBack}>← Back to slides</button>
        <div className="account-head">
          <span className="avatar big">{display[0].toUpperCase()}</span>
          <div>
            <h2>{display}</h2>
            <p className="muted">Signed in</p>
          </div>
        </div>
        <dl className="account-info">
          {user.name && <><dt>Name</dt><dd>{user.name}</dd></>}
          <dt>Email</dt><dd>{user.email}</dd>
          <dt>Account ID</dt><dd>#{user.id}</dd>
        </dl>
        <div className="account-stats">
          <div><strong>{mine.length}</strong><span>Your slide{mine.length === 1 ? '' : 's'}</span></div>
          <div><strong>{annotated.length}</strong><span>Annotated slide{annotated.length === 1 ? '' : 's'}</span></div>
          <div><strong>{annotations}</strong><span>Annotation{annotations === 1 ? '' : 's'}</span></div>
        </div>
        <button className="wide" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}
