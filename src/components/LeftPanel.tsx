import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileLock2, Folder, FolderOpen, History, Package, RefreshCw, Search, X } from 'lucide-react';
import { call, errorText } from '../api';
import type { DirEntry, Project, Task } from '../types';
import { StateBadge, formatUsd, timeAgo } from './common';

function TreeNode({
  project,
  entry,
  depth,
  onOpen,
  selected,
}: {
  project: Project;
  entry: DirEntry;
  depth: number;
  onOpen: (rel: string) => void;
  selected: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (entry.kind !== 'dir') return onOpen(entry.rel);
    if (!open && children === null) {
      try {
        setChildren(await call<DirEntry[]>('project.listDir', { root: project.root, rel: entry.rel }));
      } catch (err) {
        setError(errorText(err));
      }
    }
    setOpen(!open);
  };

  const icon =
    entry.kind === 'dir' ? (
      entry.artifact ? (
        <Package size={14} color="var(--text-dim)" />
      ) : open ? (
        <FolderOpen size={14} color="var(--accent)" />
      ) : (
        <Folder size={14} color="var(--accent)" />
      )
    ) : entry.sensitive ? (
      <FileLock2 size={14} color="var(--warning)" />
    ) : (
      <File size={14} color="var(--text-dim)" />
    );

  return (
    <>
      <div
        className={`tree-row ${entry.artifact || entry.outside ? 'dim' : ''} ${selected === entry.rel ? 'selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => void toggle()}
        title={
          entry.sensitive
            ? `Sensitive: ${entry.sensitive}`
            : entry.artifact
              ? 'Build/dependency directory (excluded from automatic context)'
              : entry.outside
                ? 'Points outside the project'
                : entry.rel
        }
      >
        {entry.kind === 'dir' ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span style={{ width: 12 }} />}
        {icon}
        <span className="name">{entry.name}</span>
      </div>
      {error && <div className="empty-small">{error}</div>}
      {open && children?.map((c) => <TreeNode key={c.rel} project={project} entry={c} depth={depth + 1} onOpen={onOpen} selected={selected} />)}
    </>
  );
}

/** The project's files; clicking one opens it in an editor tab (`selected` is the tab in front). */
export function FileTree({
  project,
  refreshKey,
  selected,
  onOpen,
}: {
  project: Project;
  refreshKey: number;
  selected: string | null;
  onOpen: (rel: string) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setEntries(await call<DirEntry[]>('project.listDir', { root: project.root, rel: '' }));
    } catch (err) {
      setError(errorText(err));
    }
  }, [project.root]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <>
      <div className="panel-header">
        <span>Files</span>
        <span className="spacer" />
        <button className="icon-btn" title="Refresh" onClick={() => void load()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="panel-body tree">
        {error && <div className="empty-small">{error}</div>}
        {!entries && !error && <div className="empty-small">Loading…</div>}
        {entries?.length === 0 && <div className="empty-small">This folder is empty.</div>}
        {entries?.map((e) => (
          <TreeNode key={e.rel} project={project} entry={e} depth={0} onOpen={onOpen} selected={selected} />
        ))}
      </div>
    </>
  );
}

type SearchHit = { task: Task; snippet: string | null };

/** The project's sessions; typing in the search box looks through titles, prompts and messages instead. */
export function TaskList({ root, tasks, activeId, onSelect }: { root: string; tasks: Task[]; activeId: string | null; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim();

  useEffect(() => {
    setError(null);
    if (q.length < 2) return setHits(null);
    let stale = false;
    const id = setTimeout(() => {
      call<SearchHit[]>('task.search', { query: q, root })
        .then((r) => !stale && setHits(r))
        .catch((err) => !stale && setError(errorText(err)));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [q, root]);

  const rows: SearchHit[] = hits ?? tasks.map((task) => ({ task, snippet: null }));
  return (
    <>
      <div className="panel-header">
        <History size={13} />
        <span>Sessions</span>
        <span className="spacer" />
        <span className="task-search">
          <Search size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Search"
            aria-label="Search sessions"
            spellCheck={false}
          />
          {query && (
            <button className="icon-btn" onClick={() => setQuery('')} aria-label="Clear search">
              <X size={11} />
            </button>
          )}
        </span>
      </div>
      <div className="panel-body">
        {error && <div className="empty-small">{error}</div>}
        {!hits && tasks.length === 0 && <div className="empty-small">No sessions yet for this project.</div>}
        {hits?.length === 0 && <div className="empty-small">No sessions mention “{q}”.</div>}
        {rows.map(({ task: t, snippet }) => (
          <div key={t.id} className={`task-row ${t.id === activeId ? 'selected' : ''}`} onClick={() => onSelect(t.id)}>
            <span className="title" title={t.prompt}>
              {t.title}
            </span>
            {snippet && <span className="snippet">{snippet}</span>}
            <span className="meta">
              <StateBadge state={t.state} />
              <span>{formatUsd(t.cost_usd)} est.</span>
              <span>{timeAgo(t.created_at)}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
