import { useMemo, useState } from 'react';
import { SlideEntry } from './api';

interface Folder { name: string; path: string; folders: Folder[]; slides: SlideEntry[] }

/** Groups flat slide entries into folders by the path segments after `prefix` (e.g. `public/`). */
function buildTree(slides: SlideEntry[], prefix: string): Folder {
  const root: Folder = { name: '', path: '', folders: [], slides: [] };
  for (const s of slides) {
    const parts = (s.path.startsWith(prefix) ? s.path.slice(prefix.length) : s.path).split('/');
    let dir = root;
    parts.slice(0, -1).forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = dir.folders.find(f => f.path === path);
      if (!next) dir.folders.push(next = { name: part, path, folders: [], slides: [] });
      dir = next;
    });
    dir.slides.push(s);
  }
  const sort = (f: Folder) => { f.folders.sort((a, b) => a.name.localeCompare(b.name)); f.slides.sort((a, b) => a.name.localeCompare(b.name)); f.folders.forEach(sort); };
  sort(root);
  return root;
}

const countSlides = (f: Folder): number => f.slides.length + f.folders.reduce((n, c) => n + countSlides(c), 0);

interface Props {
  slides: SlideEntry[];
  prefix: string;
  currentPath?: string;
  label: (name: string) => string;
  onOpen: (path: string) => void;
}

/** Slides grouped in collapsible folders. The folder holding the open slide starts expanded. */
export default function SlideTree({ slides, prefix, currentPath, label, onOpen }: Props) {
  const tree = useMemo(() => buildTree(slides, prefix), [slides, prefix]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (f: Folder) => open[f.path] ?? (!!currentPath && currentPath.startsWith(`${prefix}${f.path}/`));
  const toggle = (f: Folder) => setOpen(o => ({ ...o, [f.path]: !isOpen(f) }));

  const renderSlides = (list: SlideEntry[]) => list.map(s => (
    <li key={s.path}>
      <button className={currentPath === s.path ? 'active' : ''} onClick={() => onOpen(s.path)}>
        <span className="slide-name" title={s.name}>{label(s.name)}</span>{s.size > 0 && <small>{(s.size / 1e6).toFixed(1)} MB</small>}
      </button>
    </li>
  ));
  const renderFolder = (f: Folder) => (
    <li key={f.path} className="folder">
      <button className="folder-toggle" aria-expanded={isOpen(f)} onClick={() => toggle(f)}>
        <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
        <span className="slide-name" title={f.name}>{f.name}</span><small>{countSlides(f)}</small>
      </button>
      {isOpen(f) && <ul className="folder-children">{f.folders.map(renderFolder)}{renderSlides(f.slides)}</ul>}
    </li>
  );

  return <ul>{tree.folders.map(renderFolder)}{renderSlides(tree.slides)}</ul>;
}
