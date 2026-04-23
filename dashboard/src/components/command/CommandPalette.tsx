/*
 * CommandPalette — ⌘K (Cmd+K on macOS, Ctrl+K elsewhere) palette.
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
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../layout/ThemeProvider';
import {
  buildCommands,
  pushRecentCommand,
  readRecentCommands,
  scoreCommand,
  type Command,
  type CommandSection,
} from './commands';

const SECTION_ORDER: CommandSection[] = ['Navigate', 'Filter', 'Action', 'Help'];

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'oklch(0% 0 0 / 0.55)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '15vh',
    zIndex: 110,
  } as const,
  panel: {
    width: 'min(640px, calc(100% - 32px))',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    boxShadow: 'var(--shadow-lg)',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '70vh',
    overflow: 'hidden',
  } as const,
  inputWrap: {
    padding: 'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--border-color)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
  } as const,
  prompt: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
    fontSize: 'var(--font-size-sm)',
  } as const,
  input: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-size-base)',
    fontFamily: 'inherit',
    outline: 'none',
  } as const,
  hint: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
  } as const,
  list: {
    overflow: 'auto',
    flex: 1,
    padding: 'var(--space-2)',
  } as const,
  sectionTitle: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    padding: 'var(--space-2) var(--space-3)',
  } as const,
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-3)',
    borderRadius: 'var(--border-radius-sm)',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
  } as const,
  itemActive: {
    background: 'var(--bg-hover)',
    color: 'var(--text-primary)',
  } as const,
  itemBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  } as const,
  itemTitle: {
    fontSize: 'var(--font-size-sm)',
    fontWeight: 500,
  } as const,
  itemSubtitle: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  shortcut: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: '2px var(--space-2)',
    color: 'var(--text-muted)',
  } as const,
  empty: {
    padding: 'var(--space-6)',
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 'var(--font-size-sm)',
  } as const,
  footer: {
    display: 'flex',
    gap: 'var(--space-3)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    padding: 'var(--space-2) var(--space-4)',
    borderTop: '1px solid var(--border-color)',
    background: 'var(--bg-tertiary)',
  } as const,
};

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenShortcuts: () => void;
}

export function CommandPalette({ open, onClose, onOpenShortcuts }: Props) {
  const navigate = useNavigate();
  const { setTheme, toggleTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allCommands = useMemo(
    () => buildCommands({ navigate, setTheme, toggleTheme, openShortcuts: onOpenShortcuts }),
    [navigate, setTheme, toggleTheme, onOpenShortcuts],
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

    return scored.map((s) => s.cmd);
  }, [allCommands, query]);

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
  }, [open, flatList, activeIndex, onClose]);

  if (!open) return null;

  const runCommand = (cmd: Command) => {
    pushRecentCommand(cmd.id);
    cmd.run();
    onClose();
  };

  return (
    <div
      style={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div style={styles.panel}>
        <div style={styles.inputWrap}>
          <span style={styles.prompt}>›</span>
          <input
            ref={inputRef}
            style={styles.input}
            placeholder="Type a command or search…"
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
          <span style={styles.hint}>esc</span>
        </div>

        <div style={styles.list} id="command-palette-list" role="listbox">
          {flatList.length === 0 && (
            <div style={styles.empty}>
              No commands match "{query}".{' '}
              <button
                type="button"
                onClick={() => setQuery('')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-primary)',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  fontSize: 'inherit',
                }}
              >
                Clear
              </button>
            </div>
          )}
          {grouped.map(({ section, items }) => (
            <div key={section}>
              <div style={styles.sectionTitle}>{section}</div>
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
                    style={{ ...styles.item, ...(isActive ? styles.itemActive : {}) }}
                  >
                    <div style={styles.itemBody}>
                      <span style={styles.itemTitle}>{cmd.title}</span>
                      {cmd.subtitle && (
                        <span style={styles.itemSubtitle}>{cmd.subtitle}</span>
                      )}
                    </div>
                    {cmd.shortcut && <span style={styles.shortcut}>{cmd.shortcut}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div style={styles.footer}>
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span style={{ marginLeft: 'auto' }}>{flatList.length} commands</span>
        </div>
      </div>
    </div>
  );
}
