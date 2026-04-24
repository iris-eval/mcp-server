import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildCommands,
  scoreCommand,
  pushRecentCommand,
  readRecentCommands,
  RECENT_COMMANDS_KEY,
  RECENT_COMMANDS_MAX,
} from '../../../src/components/command/commands';

const noop = () => undefined;
const ctx = {
  navigate: noop as never,
  setTheme: noop as never,
  toggleTheme: noop as never,
  openShortcuts: noop,
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('buildCommands', () => {
  it('produces a stable, non-empty registry', () => {
    const cmds = buildCommands(ctx);
    expect(cmds.length).toBeGreaterThan(8);
    // Every command has the required shape
    for (const cmd of cmds) {
      expect(cmd.id).toMatch(/^[a-z]+(\.[a-z-]+)+$/);
      expect(cmd.title.length).toBeGreaterThan(0);
      expect(['Navigate', 'Filter', 'Action', 'Help']).toContain(cmd.section);
      expect(typeof cmd.run).toBe('function');
    }
  });

  it('includes a Navigate command per top-level route', () => {
    const cmds = buildCommands(ctx);
    const navIds = cmds.filter((c) => c.section === 'Navigate').map((c) => c.id);
    expect(navIds).toContain('nav.dashboard');
    expect(navIds).toContain('nav.moments');
    expect(navIds).toContain('nav.rules');
    expect(navIds).toContain('nav.audit');
    expect(navIds).toContain('nav.traces');
    expect(navIds).toContain('nav.evals');
  });
});

describe('scoreCommand', () => {
  const cmds = buildCommands(ctx);
  const moments = cmds.find((c) => c.id === 'nav.moments')!;
  const dashboard = cmds.find((c) => c.id === 'nav.dashboard')!;

  it('scores empty query as match-all', () => {
    expect(scoreCommand(moments, '')).toBeGreaterThan(0);
  });

  it('exact title match scores highest', () => {
    expect(scoreCommand(moments, 'Decision Moments')).toBe(100);
  });

  it('starts-with scores higher than substring', () => {
    expect(scoreCommand(moments, 'Decision')).toBeGreaterThan(scoreCommand(moments, 'oments'));
  });

  it('keyword match still scores positively', () => {
    expect(scoreCommand(moments, 'timeline')).toBeGreaterThan(0);
  });

  it('subtitle path match scores positively', () => {
    expect(scoreCommand(moments, '/moments')).toBeGreaterThan(0);
  });

  it('non-matching query scores zero', () => {
    expect(scoreCommand(dashboard, 'sdjkjlkasjd')).toBe(0);
  });
});

describe('recent commands ring buffer', () => {
  it('starts empty', () => {
    expect(readRecentCommands()).toEqual([]);
  });

  it('pushes most-recent first', () => {
    pushRecentCommand('a');
    pushRecentCommand('b');
    expect(readRecentCommands()).toEqual(['b', 'a']);
  });

  it('deduplicates so a repeat moves to front', () => {
    pushRecentCommand('a');
    pushRecentCommand('b');
    pushRecentCommand('a');
    expect(readRecentCommands()).toEqual(['a', 'b']);
  });

  it('caps at RECENT_COMMANDS_MAX', () => {
    for (let i = 0; i < RECENT_COMMANDS_MAX + 3; i++) {
      pushRecentCommand(`cmd-${i}`);
    }
    expect(readRecentCommands().length).toBe(RECENT_COMMANDS_MAX);
    // Most recent first
    expect(readRecentCommands()[0]).toBe(`cmd-${RECENT_COMMANDS_MAX + 2}`);
  });

  it('tolerates malformed localStorage', () => {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, 'not-json');
    expect(readRecentCommands()).toEqual([]);
  });
});
