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
