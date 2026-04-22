/*
 * preferences — first-run + per-user dashboard preferences for iris-mcp.
 *
 * State lives at ~/.iris/preferences.json. The file is created on first
 * dashboard launch with `autoLaunch: true` and `firstSeen` set to the
 * current ISO timestamp.
 *
 * Subsequent runs read the file and respect the user's autoLaunch setting.
 * The env var IRIS_NO_AUTO_LAUNCH=1 overrides preferences and disables
 * auto-launch unconditionally (useful for CI, headless servers, container
 * runs, and remote SSH sessions).
 *
 * The file format is intentionally small — additional preferences will be
 * added as the dashboard grows; the schema validates known keys but
 * tolerates unknown ones forward-compatibly.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const PreferencesSchema = z
  .object({
    autoLaunch: z.boolean().default(true),
    firstSeen: z.string().datetime({ offset: true }).optional(),
    dismissedBanners: z.array(z.string()).default([]),
  })
  .passthrough();

export type Preferences = z.infer<typeof PreferencesSchema>;

export interface PreferenceState {
  /** True if `~/.iris/preferences.json` did not exist when iris-mcp started. */
  isFirstRun: boolean;
  /** Resolved preferences (defaulted + validated). */
  preferences: Preferences;
  /** Absolute path to the preferences file. */
  path: string;
}

function defaultPreferencesPath(): string {
  return join(homedir(), '.iris', 'preferences.json');
}

export function loadOrInitPreferences(
  customPath?: string,
): PreferenceState {
  const path = customPath ?? defaultPreferencesPath();

  if (!existsSync(path)) {
    const fresh: Preferences = {
      autoLaunch: true,
      firstSeen: new Date().toISOString(),
      dismissedBanners: [],
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(fresh, null, 2), 'utf-8');
    } catch {
      // Filesystem may be read-only (containerized run); we still proceed
      // with the defaults in memory but isFirstRun stays true so callers
      // can decide whether to auto-launch anyway.
    }
    return { isFirstRun: true, preferences: fresh, path };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = PreferencesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return { isFirstRun: false, preferences: parsed.data, path };
    }
    // Malformed file — fall back to defaults but DON'T overwrite the
    // existing file. The user may want to fix it manually.
    return {
      isFirstRun: false,
      preferences: PreferencesSchema.parse({}),
      path,
    };
  } catch {
    return {
      isFirstRun: false,
      preferences: PreferencesSchema.parse({}),
      path,
    };
  }
}

export function shouldAutoLaunchDashboard(state: PreferenceState): boolean {
  if (process.env.IRIS_NO_AUTO_LAUNCH === '1') return false;
  if (process.env.CI === 'true' || process.env.CI === '1') return false;
  return state.preferences.autoLaunch !== false;
}
