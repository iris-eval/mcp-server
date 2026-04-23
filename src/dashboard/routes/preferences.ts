import { Router } from 'express';
import { z } from 'zod';
import type { PreferenceStore } from '../../preferences.js';

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

export function registerPreferencesRoutes(
  router: Router,
  store: PreferenceStore,
): void {
  router.get('/preferences', (_req, res) => {
    res.json({ preferences: store.read(), path: store.path });
  });

  router.patch('/preferences', (req, res) => {
    try {
      const patch = PatchSchema.parse(req.body);
      const updated = store.patch(patch);
      res.json({ preferences: updated, path: store.path });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid preferences patch', details: err.issues });
        return;
      }
      throw err;
    }
  });
}
