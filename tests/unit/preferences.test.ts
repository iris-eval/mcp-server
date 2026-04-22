import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrInitPreferences,
  shouldAutoLaunchDashboard,
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
