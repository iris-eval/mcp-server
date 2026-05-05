import { Router } from 'express';
import { z } from 'zod';
import type { IStorageAdapter } from '../../types/query.js';
import type { CustomRuleStore } from '../../custom-rule-store.js';
import type { EvalEngine } from '../../eval/engine.js';
import { createCustomRule } from '../../eval/rules/custom.js';
import { requireTenant } from '../../middleware/tenant.js';
import type { TenantId } from '../../types/tenant.js';
import type { RulePreviewResult } from '../../types/custom-rule.js';
import type { CustomRuleDefinition } from '../../types/eval.js';

const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
const EvalTypeSchema = z.enum(['completeness', 'relevance', 'safety', 'cost', 'custom']);
const RuleTypeSchema = z.enum([
  'regex_match',
  'regex_no_match',
  'min_length',
  'max_length',
  'contains_keywords',
  'excludes_keywords',
  'json_schema',
  'cost_threshold',
]);

const DefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  type: RuleTypeSchema,
  config: z.record(z.unknown()),
  weight: z.number().positive().optional(),
});

const DeploySchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-z0-9._-]+$/i, 'Use letters, digits, dot, dash, underscore'),
  description: z.string().max(500).optional(),
  evalType: EvalTypeSchema,
  severity: SeveritySchema.optional(),
  definition: DefinitionSchema,
  sourceMomentId: z.string().optional(),
});

const PreviewSchema = z.object({
  definition: DefinitionSchema,
  evalType: EvalTypeSchema.default('custom'),
  /** Window in days; default 7. Hard cap at 30 to keep memory bounded. */
  windowDays: z.coerce.number().int().min(1).max(30).default(7),
  /** Trace cap; default 1000. */
  maxTraces: z.coerce.number().int().min(1).max(5000).default(1000),
});

interface RoutesOptions {
  customRuleStore: CustomRuleStore;
  evalEngine: EvalEngine;
}

export function registerRuleRoutes(
  router: Router,
  storage: IStorageAdapter,
  opts: RoutesOptions,
): void {
  /*
   * Tenant gate. Every /rules/custom route asserts a tenant has been
   * resolved by the middleware before acting. In OSS this always passes
   * (tenant middleware sets LOCAL_TENANT for every request); in Cloud
   * the gate refuses to run on unauthenticated requests that bypass
   * the auth+tenant middleware. The resolved id is currently NOT
   * threaded into customRuleStore — that lands in PR 3b. Today the
   * store hardcodes 'local'; the gate is the route-level prerequisite
   * for the store-level fix.
   */

  router.get('/rules/custom', (req, res) => {
    requireTenant(req);
    const rules = opts.customRuleStore.list();
    res.json({ rules });
  });

  router.post('/rules/custom', async (req, res) => {
    try {
      requireTenant(req);
      const input = DeploySchema.parse(req.body);

      // Server overrides the inner definition's `name` so it always matches the
      // user-facing rule name. Avoids confusion when the rule name and the
      // inner definition's check name diverge.
      const definition: CustomRuleDefinition = {
        ...input.definition,
        name: input.name,
      };

      const rule = opts.customRuleStore.deploy({
        name: input.name,
        description: input.description,
        evalType: input.evalType,
        severity: input.severity,
        definition,
        sourceMomentId: input.sourceMomentId,
      });

      // Register the new rule with the live engine so it fires on subsequent
      // evaluate_output calls without requiring a server restart.
      opts.evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition));

      res.status(201).json({ rule });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid rule definition', details: err.issues });
        return;
      }
      throw err;
    }
  });

  router.delete('/rules/custom/:id', (req, res) => {
    requireTenant(req);
    const removed = opts.customRuleStore.delete(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    // Note: removing from the live engine requires a registry reset, which
    // the engine doesn't expose in v0.4. The deleted rule continues to fire
    // until the next iris-mcp restart. Documented behavior; v0.4.1 adds
    // engine.unregisterRule for hot-removal.
    res.status(204).end();
  });

  router.post('/rules/custom/preview', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const input = PreviewSchema.parse(req.body);
      const result = await previewRule(tenantId, input, storage);
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid preview request', details: err.issues });
        return;
      }
      const status = (err as { status?: number }).status;
      if (status === 422) {
        res.status(422).json({ error: 'Rule definition rejected', message: (err as Error).message });
        return;
      }
      throw err;
    }
  });
}

async function previewRule(
  tenantId: TenantId,
  input: z.infer<typeof PreviewSchema>,
  storage: IStorageAdapter,
): Promise<RulePreviewResult> {
  const since = new Date(Date.now() - input.windowDays * 24 * 60 * 60 * 1000).toISOString();
  const traceResult = await storage.queryTraces(tenantId, {
    filter: { since },
    limit: input.maxTraces,
    sort_by: 'timestamp',
    sort_order: 'desc',
  });

  const rule = createCustomRule(input.definition);

  // Sanity-probe the rule against an empty input. Compile-time errors
  // (invalid regex, pattern too long, ReDoS rejection) surface here as a
  // failed result with a recognizable error prefix. Surface as a 422 so
  // the UI can show the error instead of a misleading "5 traces fail."
  const probe = rule.evaluate({ output: '' });
  if (
    !probe.skipped &&
    !probe.passed &&
    /^(?:Invalid regex|Regex pattern (?:too long|rejected))/.test(probe.message)
  ) {
    const err = new Error(probe.message) as Error & { status?: number };
    err.status = 422;
    throw err;
  }

  let wouldPass = 0;
  let wouldFail = 0;
  let wouldSkip = 0;
  const examples: RulePreviewResult['examples'] = [];

  for (const trace of traceResult.traces) {
    if (trace.output === undefined) {
      wouldSkip++;
      continue;
    }
    const result = rule.evaluate({
      output: trace.output,
      input: trace.input,
      costUsd: trace.cost_usd,
      tokenUsage: trace.token_usage,
    });
    if (result.skipped) {
      wouldSkip++;
    } else if (result.passed) {
      wouldPass++;
    } else {
      wouldFail++;
      if (examples.length < 5) {
        examples.push({
          traceId: trace.trace_id,
          agentName: trace.agent_name,
          timestamp: trace.timestamp,
          outputPreview: trace.output.slice(0, 200),
        });
      }
    }
  }

  return {
    tracesEvaluated: traceResult.traces.length,
    wouldFail,
    wouldPass,
    wouldSkip,
    examples,
    windowSinceIso: since,
  };
}
