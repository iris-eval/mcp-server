import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrInitPreferences,
  shouldAutoLaunchDashboard,
  createPreferenceStore,
} from '../../src/preferences.js';

let tmpDir: string;
let prefPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-pref-'));
  prefPath = join(tmpDir, 'preferences.json');
  delete process.env.IRIS_NO_AUTO_LAUNCH;
  delete process.env.CI;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.IRIS_NO_AUTO_LAUNCH;
  delete process.env.CI;
});

describe('loadOrInitPreferences', () => {
  it('creates a fresh preferences file on first run', () => {
    const state = loadOrInitPreferences(prefPath);
    expect(state.isFirstRun).toBe(true);
    expect(state.preferences.autoLaunch).toBe(true);
    expect(state.preferences.firstSeen).toBeDefined();
    expect(state.preferences.dismissedBanners).toEqual([]);
    expect(existsSync(prefPath)).toBe(true);
  });

  it('reads an existing preferences file without flagging first run', () => {
    loadOrInitPreferences(prefPath);
    const second = loadOrInitPreferences(prefPath);
    expect(second.isFirstRun).toBe(false);
    expect(second.preferences.autoLaunch).toBe(true);
  });

  it('respects autoLaunch=false from existing file', () => {
    writeFileSync(
      prefPath,
      JSON.stringify({
        autoLaunch: false,
        firstSeen: '2026-04-01T00:00:00.000Z',
        dismissedBanners: ['welcome'],
      }),
    );
    const state = loadOrInitPreferences(prefPath);
    expect(state.preferences.autoLaunch).toBe(false);
    expect(state.preferences.dismissedBanners).toEqual(['welcome']);
  });

  it('falls back to defaults when file is malformed but does not overwrite', () => {
    writeFileSync(prefPath, '{"autoLaunch": "not-a-bool",}');
    const state = loadOrInitPreferences(prefPath);
    expect(state.preferences.autoLaunch).toBe(true);
    // File untouched — user can still fix manually
    expect(readFileSync(prefPath, 'utf-8')).toBe('{"autoLaunch": "not-a-bool",}');
  });
});

describe('loadOrInitPreferences — v0.4 fields', () => {
  it('initializes new fields with sensible defaults', () => {
    const state = loadOrInitPreferences(prefPath);
    expect(state.preferences.theme).toBe('system');
    expect(state.preferences.momentFilters).toEqual({});
    expect(state.preferences.dismissedTours).toEqual([]);
    expect(state.preferences.archivedMoments).toEqual([]);
  });

  it('preserves existing fields + back-fills new ones from older files', () => {
    writeFileSync(
      prefPath,
      JSON.stringify({
        autoLaunch: true,
        firstSeen: '2026-04-01T00:00:00.000Z',
        dismissedBanners: ['welcome'],
      }),
    );
    const state = loadOrInitPreferences(prefPath);
    expect(state.preferences.autoLaunch).toBe(true);
    expect(state.preferences.dismissedBanners).toEqual(['welcome']);
    // New fields default in
    expect(state.preferences.theme).toBe('system');
    expect(state.preferences.momentFilters).toEqual({});
  });

  it('back-fills v0.4.0 fields from a v0.3.x preferences.json', () => {
    // Represents a user who upgraded from v0.3.x → v0.4.0. The on-disk
    // file has the v0.3.x schema (no density / sidebarCollapsed /
    // notificationsLastSeen). Must not crash + must populate sensible
    // defaults so v2.C chrome renders without throwing.
    writeFileSync(
      prefPath,
      JSON.stringify({
        autoLaunch: true,
        firstSeen: '2026-04-01T00:00:00.000Z',
        dismissedBanners: ['welcome'],
        theme: 'dark',
        momentFilters: { verdict: 'fail' },
        dismissedTours: ['tour-welcome'],
        archivedMoments: ['moment-abc'],
        // density + sidebarCollapsed + notificationsLastSeen absent —
        // user's v0.3.x file wouldn't have them
      }),
    );
    const state = loadOrInitPreferences(prefPath);
    // Existing v0.3 fields preserved verbatim
    expect(state.preferences.autoLaunch).toBe(true);
    expect(state.preferences.theme).toBe('dark');
    expect(state.preferences.momentFilters).toEqual({ verdict: 'fail' });
    expect(state.preferences.dismissedTours).toEqual(['tour-welcome']);
    expect(state.preferences.archivedMoments).toEqual(['moment-abc']);
    // v0.4 fields back-fill with defaults (R2.3: compact default,
    // sidebar expanded by default, no unread-cursor set)
    expect(state.preferences.density).toBe('compact');
    expect(state.preferences.sidebarCollapsed).toBe(false);
    expect(state.preferences.notificationsLastSeen).toBeUndefined();
  });

  it('round-trips new v0.4.0 fields through createPreferenceStore.patch', () => {
    const store = createPreferenceStore(prefPath);
    const updated = store.patch({
      density: 'comfortable',
      sidebarCollapsed: true,
      notificationsLastSeen: '2026-04-23T20:00:00.000Z',
    });
    expect(updated.density).toBe('comfortable');
    expect(updated.sidebarCollapsed).toBe(true);
    expect(updated.notificationsLastSeen).toBe('2026-04-23T20:00:00.000Z');
    // Persist to disk + re-read
    const state = loadOrInitPreferences(prefPath);
    expect(state.preferences.density).toBe('comfortable');
    expect(state.preferences.sidebarCollapsed).toBe(true);
    expect(state.preferences.notificationsLastSeen).toBe('2026-04-23T20:00:00.000Z');
  });

  it('rejects invalid density values via Zod', () => {
    const store = createPreferenceStore(prefPath);
    expect(() => store.patch({ density: 'dense' as never })).toThrow();
    expect(store.read().density).toBe('compact');
  });

  it('rejects non-ISO notificationsLastSeen via Zod', () => {
    const store = createPreferenceStore(prefPath);
    expect(() =>
      store.patch({ notificationsLastSeen: 'yesterday' as never }),
    ).toThrow();
    expect(store.read().notificationsLastSeen).toBeUndefined();
  });
});

describe('createPreferenceStore', () => {
  it('reads + patches in-memory + persists to disk atomically', () => {
    const store = createPreferenceStore(prefPath);
    expect(store.read().autoLaunch).toBe(true);

    const updated = store.patch({ theme: 'dark' });
    expect(updated.theme).toBe('dark');
    expect(store.read().theme).toBe('dark');

    // On-disk reflects the patch
    const onDisk = JSON.parse(readFileSync(prefPath, 'utf-8'));
    expect(onDisk.theme).toBe('dark');
  });

  it('rejects invalid patch values via Zod', () => {
    const store = createPreferenceStore(prefPath);
    // Theme must be 'dark' | 'light' | 'system'
    expect(() => store.patch({ theme: 'plaid' as never })).toThrow();
    // Theme stays at default
    expect(store.read().theme).toBe('system');
  });

  it('preserves unknown forward-compat keys via passthrough', () => {
    writeFileSync(
      prefPath,
      JSON.stringify({
        autoLaunch: true,
        firstSeen: '2026-04-01T00:00:00.000Z',
        dismissedBanners: [],
        futureFeature: { someKey: 'someValue' },
      }),
    );
    const store = createPreferenceStore(prefPath);
    store.patch({ theme: 'light' });
    const onDisk = JSON.parse(readFileSync(prefPath, 'utf-8'));
    expect(onDisk.futureFeature).toEqual({ someKey: 'someValue' });
    expect(onDisk.theme).toBe('light');
  });

  it('patches momentFilters as a single object replacement', () => {
    const store = createPreferenceStore(prefPath);
    store.patch({ momentFilters: { agentName: 'support-agent', verdict: 'fail' } });
    expect(store.read().momentFilters).toEqual({
      agentName: 'support-agent',
      verdict: 'fail',
    });
    // Subsequent patch with a smaller filter set replaces, not merges
    store.patch({ momentFilters: { significanceKind: 'safety-violation' } });
    expect(store.read().momentFilters).toEqual({
      significanceKind: 'safety-violation',
    });
  });
});

describe('shouldAutoLaunchDashboard', () => {
  it('returns true on first run with default preferences', () => {
    const state = loadOrInitPreferences(prefPath);
    expect(shouldAutoLaunchDashboard(state)).toBe(true);
  });

  it('returns false when IRIS_NO_AUTO_LAUNCH=1', () => {
    process.env.IRIS_NO_AUTO_LAUNCH = '1';
    const state = loadOrInitPreferences(prefPath);
    expect(shouldAutoLaunchDashboard(state)).toBe(false);
  });

  it('returns false when CI=true', () => {
    process.env.CI = 'true';
    const state = loadOrInitPreferences(prefPath);
    expect(shouldAutoLaunchDashboard(state)).toBe(false);
  });

  it('returns false when stored preferences disable auto-launch', () => {
    writeFileSync(
      prefPath,
      JSON.stringify({ autoLaunch: false, firstSeen: '2026-04-01T00:00:00.000Z', dismissedBanners: [] }),
    );
    const state = loadOrInitPreferences(prefPath);
    expect(shouldAutoLaunchDashboard(state)).toBe(false);
  });
});
