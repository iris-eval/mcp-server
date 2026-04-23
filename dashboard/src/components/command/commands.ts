/*
 * Command registry — every action available via the ⌘K palette and the
 * keyboard-shortcuts overlay (?). Keep this list flat + searchable; the
 * palette ranks matches by substring + recency.
 *
 * Each command exposes:
 *   - id: stable identifier used for recent-commands tracking
 *   - title: shown in palette, also matched for search
 *   - subtitle: optional second line (e.g., shortcut, destination path)
 *   - keywords: extra search terms (e.g., "settings" → theme command)
 *   - shortcut: optional displayed shortcut (e.g., "g m" for "go to moments")
 *   - run: function executed when the command is selected
 *   - section: visual grouping in the palette
 */
import type { NavigateFunction } from 'react-router-dom';

export type CommandSection = 'Navigate' | 'Filter' | 'Action' | 'Help';

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  shortcut?: string;
  section: CommandSection;
  run: () => void;
}

export interface CommandContext {
  navigate: NavigateFunction;
  setTheme: (theme: 'dark' | 'light') => void;
  toggleTheme: () => void;
  /** Open the keyboard shortcuts overlay. */
  openShortcuts: () => void;
}

export function buildCommands(ctx: CommandContext): Command[] {
  return [
    // ── Navigate ─────────────────────────────────────────────
    {
      id: 'nav.dashboard',
      title: 'Dashboard',
      subtitle: '/',
      keywords: ['home', 'overview', 'metrics'],
      shortcut: 'g d',
      section: 'Navigate',
      run: () => ctx.navigate('/'),
    },
    {
      id: 'nav.moments',
      title: 'Decision Moments',
      subtitle: '/moments',
      keywords: ['timeline', 'traces', 'classified'],
      shortcut: 'g m',
      section: 'Navigate',
      run: () => ctx.navigate('/moments'),
    },
    {
      id: 'nav.rules',
      title: 'Custom Rules',
      subtitle: '/rules',
      keywords: ['deployed', 'composer', 'eval'],
      shortcut: 'g r',
      section: 'Navigate',
      run: () => ctx.navigate('/rules'),
    },
    {
      id: 'nav.audit',
      title: 'Audit Log',
      subtitle: '/audit',
      keywords: ['history', 'changes', 'log'],
      shortcut: 'g a',
      section: 'Navigate',
      run: () => ctx.navigate('/audit'),
    },
    {
      id: 'nav.traces',
      title: 'Traces',
      subtitle: '/traces',
      keywords: ['raw', 'spans', 'trace'],
      shortcut: 'g t',
      section: 'Navigate',
      run: () => ctx.navigate('/traces'),
    },
    {
      id: 'nav.evals',
      title: 'Evaluations',
      subtitle: '/evals',
      keywords: ['scores', 'results'],
      shortcut: 'g e',
      section: 'Navigate',
      run: () => ctx.navigate('/evals'),
    },

    // ── Filter (page-aware shortcuts) ────────────────────────
    {
      id: 'filter.safety',
      title: 'Filter moments: safety violations',
      subtitle: 'Apply significance_kind=safety-violation',
      keywords: ['pii', 'injection', 'safety'],
      section: 'Filter',
      run: () => ctx.navigate('/moments?kind=safety-violation'),
    },
    {
      id: 'filter.cost',
      title: 'Filter moments: cost spikes',
      subtitle: 'Apply significance_kind=cost-spike',
      keywords: ['cost', 'expensive', 'budget'],
      section: 'Filter',
      run: () => ctx.navigate('/moments?kind=cost-spike'),
    },
    {
      id: 'filter.fail',
      title: 'Filter moments: failures only',
      subtitle: 'Apply verdict=fail',
      keywords: ['failed', 'broken'],
      section: 'Filter',
      run: () => ctx.navigate('/moments?verdict=fail'),
    },
    {
      id: 'filter.clear',
      title: 'Filter moments: clear all',
      subtitle: 'Show every moment',
      keywords: ['reset', 'clear'],
      section: 'Filter',
      run: () => ctx.navigate('/moments'),
    },

    // ── Actions ──────────────────────────────────────────────
    {
      id: 'action.theme.toggle',
      title: 'Toggle theme (dark / light)',
      keywords: ['dark', 'light', 'theme', 'settings'],
      section: 'Action',
      run: () => ctx.toggleTheme(),
    },
    {
      id: 'action.theme.dark',
      title: 'Switch to dark theme',
      keywords: ['dark', 'theme'],
      section: 'Action',
      run: () => ctx.setTheme('dark'),
    },
    {
      id: 'action.theme.light',
      title: 'Switch to light theme',
      keywords: ['light', 'theme'],
      section: 'Action',
      run: () => ctx.setTheme('light'),
    },
    {
      id: 'action.copy-url',
      title: 'Copy current URL',
      subtitle: 'Permalink the active filtered view',
      keywords: ['share', 'permalink', 'copy'],
      section: 'Action',
      run: () => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(window.location.href).catch(() => undefined);
        }
      },
    },

    // ── Help ─────────────────────────────────────────────────
    {
      id: 'help.shortcuts',
      title: 'Keyboard shortcuts',
      subtitle: 'Show all keyboard shortcuts',
      keywords: ['shortcut', 'keys', 'help'],
      shortcut: '?',
      section: 'Help',
      run: () => ctx.openShortcuts(),
    },
    {
      id: 'help.docs',
      title: 'Open Iris docs',
      subtitle: 'iris-eval.com/docs',
      keywords: ['help', 'documentation'],
      section: 'Help',
      run: () => window.open('https://iris-eval.com/docs', '_blank', 'noopener'),
    },
  ];
}

/* Score a command against a query — substring on title / subtitle / keywords.
 * Higher score = better match. 0 = no match (filtered out). */
export function scoreCommand(cmd: Command, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const title = cmd.title.toLowerCase();
  const sub = cmd.subtitle?.toLowerCase() ?? '';
  const kw = (cmd.keywords ?? []).join(' ').toLowerCase();

  // Exact title match → highest
  if (title === q) return 100;
  // Title starts-with → high
  if (title.startsWith(q)) return 50;
  // Title substring
  if (title.includes(q)) return 25;
  // Subtitle / keywords substring
  if (sub.includes(q) || kw.includes(q)) return 10;
  return 0;
}

/* Local-storage key for recent command ids. Bounded to last 5. */
export const RECENT_COMMANDS_KEY = 'iris-recent-commands';
export const RECENT_COMMANDS_MAX = 5;

export function readRecentCommands(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_COMMANDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string').slice(0, RECENT_COMMANDS_MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecentCommand(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const current = readRecentCommands().filter((x) => x !== id);
    const next = [id, ...current].slice(0, RECENT_COMMANDS_MAX);
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be disabled in private mode; recent-commands ranking
    // simply degrades to no-recents — palette still works.
  }
}
