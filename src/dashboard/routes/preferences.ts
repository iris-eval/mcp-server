import { Router } from 'express';
import { z } from 'zod';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { PreferenceStore } from '../../preferences.js';
import { irisHome } from '../../utils/iris-home.js';

/* PATCH body schema. Every field optional + strict (rejects unknown keys
 * to catch typos at the API boundary). Inner schemas mirror preferences.ts. */
const MomentFiltersPatchSchema = z
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

const PatchSchema = z
  .object({
    autoLaunch: z.boolean().optional(),
    dismissedBanners: z.array(z.string().max(80)).optional(),
    theme: z.enum(['dark', 'light', 'system']).optional(),
    momentFilters: MomentFiltersPatchSchema.optional(),
    dismissedTours: z.array(z.string().max(80)).optional(),
    archivedMoments: z.array(z.string().max(200)).optional(),
    density: z.enum(['compact', 'comfortable']).optional(),
    sidebarCollapsed: z.boolean().optional(),
    notificationsLastSeen: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/*
 * The preferences file's location, in a form safe to show in a browser.
 *
 * Two constraints pull against each other. The welcome banner used to
 * hardcode `~/.iris/preferences.json`, which is wrong whenever IRIS_HOME
 * points elsewhere and always wrong in --demo mode (demo-preferences.json)
 * (#377 item 2). But the absolute path must NOT go over the wire: it
 * embeds the OS username (install-path disclosure, CWE-209 — #334, the
 * reason store.path was removed from these responses in the first place).
 *
 * So the response carries a DISPLAY path: the real file name under the
 * real home, with the home spelled the way the user configured it —
 * `$IRIS_HOME/…` when the env var is set, `~/.iris/…` otherwise. A store
 * pointed outside the iris home (embedders, tests) shows the bare file
 * name rather than any directory.
 */
export function preferencesDisplayPath(absolutePath: string): string {
  const home = irisHome();
  const rel = relative(home, absolutePath);
  const insideHome = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (!insideHome) return basename(absolutePath);
  const prefix = process.env.IRIS_HOME ? '$IRIS_HOME' : '~/.iris';
  return `${prefix}/${rel.split(sep).join('/')}`;
}

export function registerPreferencesRoutes(
  router: Router,
  store: PreferenceStore,
): void {
  /*
   * Responses deliberately omit store.path: the absolute path embeds the
   * OS username (install-path disclosure, CWE-209 — same class as PR
   * #286) and the frontend never read it. `displayPath` is the
   * username-free form (see preferencesDisplayPath).
   */
  router.get('/preferences', (_req, res) => {
    res.json({ preferences: store.read(), displayPath: preferencesDisplayPath(store.path) });
  });

  router.patch('/preferences', (req, res) => {
    try {
      const patch = PatchSchema.parse(req.body);
      const updated = store.patch(patch);
      res.json({ preferences: updated, displayPath: preferencesDisplayPath(store.path) });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid preferences patch', details: err.issues });
        return;
      }
      throw err;
    }
  });
}
