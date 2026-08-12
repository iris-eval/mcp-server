/*
 * CommandPalette — ⌘K (Cmd+K on macOS, Ctrl+K elsewhere) palette.
 *
 * Searches BOTH the command registry and the user's data (rules, traces,
 * recent evals — via useCommandSearch). In Linear and Stripe the palette
 * IS search; commands alone made ours a fancy nav menu.
 *
 * Opens via:
 *   - The ⌘K shortcut (handled in CommandPaletteProvider's global listener)
 *   - Clicking the trigger in Header
 *
 * Closes via:
 *   - ESC
 *   - Click outside
 *   - Selecting a command
 *
 * Keyboard nav:
 *   - ArrowDown / ArrowUp: change selection
 *   - Enter: run selected command
 *   - / or letters: type to filter
 *
 * Accessibility:
 *   - role="dialog" + aria-modal="true"
 *   - aria-activedescendant tracks selection
 *   - Each item has role="option" with stable id
 *   - Focus restored to trigger on close
 *
 * Static styling lives in utilities.css (.cmdk block). No entrance
 * animation by design — high-frequency surfaces open instantly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTheme } from '../layout/ThemeProvider';
import {
  buildCommands,
  pushRecentCommand,
  readRecentCommands,
  scoreCommand,
  type Command,
  type CommandSection,
} from './commands';
import { useCommandSearch, type DataMatch } from './useCommandSearch';

/* Data sections sit right under Navigate: when the user types, their own
 * rules/traces/evals are usually the thing they're hunting. */
const SECTION_ORDER: CommandSection[] = [
  'Navigate',
  'Rules',
  'Traces',
  'Evals',
  'Filter',
  'Action',
  'Help',
];

const DATA_SECTION: Record<DataMatch['kind'], CommandSection> = {
  rule: 'Rules',
  trace: 'Traces',
  eval: 'Evals',
};

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenShortcuts: () => void;
  /** Optional — when provided, the "Onboarding tour" command re-opens the tour. */
  onOpenTour?: () => void;
}

export function CommandPalette({ open, onClose, onOpenShortcuts, onOpenTour }: Props) {
  const navigate = useNavigate();
  const { setTheme, toggleTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allCommands = useMemo(
    () => buildCommands({ navigate, setTheme, toggleTheme, openShortcuts: onOpenShortcuts, openTour: onOpenTour }),
    [navigate, setTheme, toggleTheme, onOpenShortcuts, onOpenTour],
  );

  const { matches: dataMatches, searching } = useCommandSearch(open, query);

  /* Data matches arrive pre-filtered + pre-ranked by useCommandSearch;
   * wrap them as commands that navigate to the matched resource. */
  const dataCommands = useMemo<Command[]>(
    () =>
      dataMatches.map((m) => ({
        id: m.id,
        title: m.title,
        subtitle: m.subtitle,
        section: DATA_SECTION[m.kind],
        run: () => navigate(m.to),
      })),
    [dataMatches, navigate],
  );

  const filtered = useMemo(() => {
    const recents = new Set(readRecentCommands());
    const scored = allCommands
      .map((cmd) => ({ cmd, score: scoreCommand(cmd, query.trim()) }))
      .filter((entry) => entry.score > 0);

    // Sort: score desc, then recents bonus, then alphabetical
    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const aRecent = recents.has(a.cmd.id) ? 1 : 0;
      const bRecent = recents.has(b.cmd.id) ? 1 : 0;
      if (aRecent !== bRecent) return bRecent - aRecent;
      return a.cmd.title.localeCompare(b.cmd.title);
    });

    return [...scored.map((s) => s.cmd), ...dataCommands];
  }, [allCommands, dataCommands, query]);

  // Group filtered commands by section while preserving the global ranked order
  // within each section so recents/scores still bubble up.
  const grouped = useMemo(() => {
    const out = new Map<CommandSection, Command[]>();
    for (const cmd of filtered) {
      const arr = out.get(cmd.section) ?? [];
      arr.push(cmd);
      out.set(cmd.section, arr);
    }
    return SECTION_ORDER.flatMap((section) =>
      out.has(section) ? [{ section, items: out.get(section)! }] : [],
    );
  }, [filtered]);

  const flatList = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  // Reset state on open + auto-focus the input
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Defer focus until after the panel mounts
      const id = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Clamp active index when filter changes
  useEffect(() => {
    if (activeIndex >= flatList.length) {
      setActiveIndex(Math.max(0, flatList.length - 1));
    }
  }, [flatList, activeIndex]);

  /*
   * runCommand is referenced from the global keyboard handler (Enter key).
   * Defined with useCallback BEFORE the useEffect that depends on it so the
   * dep array can include it without violating rules-of-hooks ordering.
   */
  const runCommand = useCallback(
    (cmd: Command) => {
      pushRecentCommand(cmd.id);
      cmd.run();
      onClose();
    },
    [onClose],
  );

  // Global keyboard handlers (only while open)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (flatList.length === 0 ? 0 : (i + 1) % flatList.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) =>
          flatList.length === 0 ? 0 : (i - 1 + flatList.length) % flatList.length,
        );
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = flatList[activeIndex];
        if (cmd) runCommand(cmd);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, flatList, activeIndex, onClose, runCommand]);

  if (!open) return null;

  return (
    <div
      className="iris-backdrop cmdk-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="iris-modal cmdk__panel">
        <div className="cmdk__input-wrap">
          <span className="cmdk__prompt">›</span>
          <input
            ref={inputRef}
            className="cmdk__input"
            placeholder="Search your rules, traces, evals — or type a command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            aria-label="Command query"
            aria-autocomplete="list"
            aria-controls="command-palette-list"
            aria-activedescendant={
              flatList[activeIndex] ? `cmd-${flatList[activeIndex].id}` : undefined
            }
          />
          <span className="iris-kbd">esc</span>
        </div>

        <div className="cmdk__list" id="command-palette-list" role="listbox">
          {flatList.length === 0 && (
            <div className="cmdk__empty">
              {searching ? (
                <>Searching your data…</>
              ) : (
                <>
                  Nothing matches "{query}".{' '}
                  <button type="button" onClick={() => setQuery('')} className="cmdk__empty-clear">
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
          {grouped.map(({ section, items }) => (
            <div key={section}>
              <div className="cmdk__section-title">{section}</div>
              {items.map((cmd) => {
                const isActive = flatList[activeIndex]?.id === cmd.id;
                return (
                  <div
                    key={cmd.id}
                    id={`cmd-${cmd.id}`}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => setActiveIndex(flatList.indexOf(cmd))}
                    onClick={() => runCommand(cmd)}
                    className="cmdk__item"
                  >
                    <div className="cmdk__item-body">
                      <span className="cmdk__item-title">{cmd.title}</span>
                      {cmd.subtitle && (
                        <span className="cmdk__item-subtitle">{cmd.subtitle}</span>
                      )}
                    </div>
                    {cmd.shortcut && <span className="iris-kbd">{cmd.shortcut}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="cmdk__footer">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span className="cmdk__footer-count">
            {searching ? 'searching data…' : `${flatList.length} results`}
          </span>
        </div>
      </div>
    </div>
  );
}
