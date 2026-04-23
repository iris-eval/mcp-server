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
 *
 * v0.4 expansions (B8.2): theme, momentFilters (last filter set used on
 * /moments), dismissedTours, archivedMoments. These let the dashboard
 * remember the user's last view across reloads + across iris-mcp restarts.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const MomentFiltersSchema = z
  .object({
    agentName: z.string().max(200).optional(),
    verdict: z.enum(['pass', 'fail', 'partial', 'unevaluated']).optional(),
    significanceKind: z
      .enum([
        'safety-violation',
        'cost-spike',
        'first-failure',
        'novel-pattern',
        'rule-collision',
        'normal-pass',
        'normal-fail',
      ])
      .optional(),
  })
  .strict();

export const PreferencesSchema = z
  .object({
    autoLaunch: z.boolean().default(true),
    firstSeen: z.string().datetime({ offset: true }).optional(),
    dismissedBanners: z.array(z.string().max(80)).default([]),
    /** Theme override; "system" defers to prefers-color-scheme. v0.4. */
    theme: z.enum(['dark', 'light', 'system']).default('system'),
    /** Last filter set used on /moments — applied on next visit when the URL has no filter params. v0.4. */
    momentFilters: MomentFiltersSchema.default({}),
    /** Tour ids the user has completed or dismissed. v0.4. */
    dismissedTours: z.array(z.string().max(80)).default([]),
    /** Decision Moments hidden from the timeline by user action. v0.4. */
    archivedMoments: z.array(z.string().max(200)).default([]),
    /** Density mode for chrome (Design System v2.A). 'compact' default per R2.3. */
    density: z.enum(['compact', 'comfortable']).default('compact'),
    /** Sidebar collapsed (icon-only at 64px) vs expanded (256px). Default expanded per R2.4. */
    sidebarCollapsed: z.boolean().default(false),
    /** ISO timestamp of last notifications-popover opened — drives unread badge. */
    notificationsLastSeen: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();

export type Preferences = z.infer<typeof PreferencesSchema>;
export type MomentFilters = z.infer<typeof MomentFiltersSchema>;

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

function freshPreferences(): Preferences {
  return PreferencesSchema.parse({
    autoLaunch: true,
    firstSeen: new Date().toISOString(),
    dismissedBanners: [],
    theme: 'system',
    momentFilters: {},
    dismissedTours: [],
    archivedMoments: [],
  });
}

function writeAtomic(targetPath: string, contents: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}`;
  writeFileSync(tmp, contents, 'utf-8');
  renameSync(tmp, targetPath);
}

export function loadOrInitPreferences(customPath?: string): PreferenceState {
  const path = customPath ?? defaultPreferencesPath();

  if (!existsSync(path)) {
    const fresh = freshPreferences();
    try {
      writeAtomic(path, JSON.stringify(fresh, null, 2));
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

/* ── Mutable preferences store (B8.2) ───────────────────────────────────
 * Wraps loadOrInitPreferences with a `patch` operation so the dashboard
 * API can update preferences atomically. Used by GET/PATCH /api/v1/
 * preferences. Keeps an in-memory copy that the on-disk file mirrors.
 */
export interface PreferenceStore {
  readonly path: string;
  /** Current preferences (always defaulted + validated). */
  read(): Preferences;
  /**
   * Apply a partial update + persist atomically. Returns the merged result.
   * Throws if the merge fails Zod validation (e.g., illegal verdict value).
   */
  patch(input: Partial<Preferences>): Preferences;
}

export function createPreferenceStore(customPath?: string): PreferenceStore {
  const path = customPath ?? defaultPreferencesPath();
  let current = loadOrInitPreferences(path).preferences;

  return {
    path,
    read(): Preferences {
      return current;
    },
    patch(input: Partial<Preferences>): Preferences {
      const merged = { ...current, ...input };
      // Re-parse so default coalescing + validation runs, and so passthrough
      // forward-compat preserves any unknown keys present in the file.
      const validated = PreferencesSchema.parse(merged);
      try {
        writeAtomic(path, JSON.stringify(validated, null, 2));
      } catch (err) {
        // If persist fails (read-only fs, disk full), still update memory
        // so the UI feels responsive — but rethrow so the API surfaces it.
        current = validated;
        throw err;
      }
      current = validated;
      return validated;
    },
  };
}
