import { Router } from 'express';
import { z } from 'zod';
import type { IStorageAdapter } from '../../types/query.js';
import type { CustomRuleStore } from '../../custom-rule-store.js';
import type { EvalEngine } from '../../eval/engine.js';
import { createCustomRule } from '../../eval/rules/custom.js';
import { rulesByType } from '../../eval/rules/index.js';
import { requireTenant } from '../../middleware/tenant.js';
import type { TenantId } from '../../types/tenant.js';
import type { RulePreviewResult } from '../../types/custom-rule.js';
import type { CustomRuleDefinition, EvalType } from '../../types/eval.js';
import { DuplicateRuleNameError, replacedRulesWarning, retireSameNamedRules } from '../../tools/deploy-rule.js';
import { strictBody } from '../validation.js';

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

/*
 * Strict at every level the dashboard owns. `config` stays a free-form
 * record on purpose (each rule type reads its own keys and the store
 * validates them per type); everything around it has a fixed key set, so
 * a misspelled `wieght` is rejected instead of silently dropped (#376).
 *
 * `definition.name` is optional: the server always overwrites it with the
 * top-level rule name (#377 item 3), so requiring a value that is then
 * discarded only invited confusion.
 */
const DefinitionSchema = strictBody({
  name: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe('Optional — always replaced by the top-level rule name on deploy'),
  type: RuleTypeSchema,
  config: z.record(z.string(), z.unknown()),
  weight: z.number().positive().optional(),
});

const DeploySchema = strictBody({
  name: z.string().min(1).max(80).regex(/^[a-z0-9._-]+$/i, 'Use letters, digits, dot, dash, underscore'),
  description: z.string().max(500).optional(),
  evalType: EvalTypeSchema,
  severity: SeveritySchema.optional(),
  definition: DefinitionSchema,
  sourceMomentId: z.string().optional(),
  /**
   * Same contract as deploy_rule's `replace`: a name that is already
   * deployed is refused (409) unless this is true, in which case the
   * existing same-named rule(s) are deleted and this one takes their place.
   */
  replace: z.boolean().default(false),
});

/*
 * Bounded well under the 1mb body limit. The sample is evaluated exactly
 * once, on the main thread, inside the same regex sandbox every other
 * evaluation uses — the cap keeps one request's worst case small.
 */
const MAX_SAMPLE_OUTPUT_CHARS = 100_000;

const PreviewSchema = strictBody({
  definition: DefinitionSchema,
  evalType: EvalTypeSchema.default('custom'),
  /** Window in days; default 7. Hard cap at 30 to keep memory bounded. */
  windowDays: z.coerce.number().int().min(1).max(30).default(7),
  /** Trace cap; default 1000. */
  maxTraces: z.coerce.number().int().min(1).max(5000).default(1000),
  /**
   * Dry-run text. When present the rule is ALSO evaluated against this
   * exact output and the verdict is returned under `sample` — the
   * "validation against sample output" deploy_rule's description has
   * promised since v0.4. The endpoint used to accept the key and ignore it
   * (#373 item 2): a caller got back the historical replay only, with no
   * hint that their sample was never looked at.
   */
  sampleOutput: z.string().max(MAX_SAMPLE_OUTPUT_CHARS).optional(),
});

const ToggleSchema = strictBody({
  enabled: z.boolean(),
});

interface RoutesOptions {
  customRuleStore: CustomRuleStore;
  evalEngine: EvalEngine;
}

/** Built-in rule metadata as the dashboard sees it — derived from the engine, never restated. */
export interface BuiltInRuleMeta {
  name: string;
  category: EvalType;
  description: string;
  weight: number;
  critical: boolean;
}

export function listBuiltInRules(): BuiltInRuleMeta[] {
  const out: BuiltInRuleMeta[] = [];
  for (const [category, rules] of Object.entries(rulesByType) as Array<[EvalType, typeof rulesByType.safety]>) {
    for (const rule of rules) {
      out.push({
        name: rule.name,
        category,
        description: rule.description,
        weight: rule.weight,
        critical: rule.critical === true,
      });
    }
  }
  return out;
}

export function registerRuleRoutes(
  router: Router,
  storage: IStorageAdapter,
  opts: RoutesOptions,
): void {
  /*
   * Every /rules/custom route resolves the tenant via requireTenant(req)
   * and threads it through to the store. In OSS the tenant middleware
   * always sets LOCAL_TENANT, so all rules continue to live at
   * ~/.iris/custom-rules.json (the v0.4 path — zero migration). In Cloud,
   * each tenant's rules will live in their own file (per-tenant partition)
   * and writes will only ever touch the resolved tenant's data.
   */

  /*
   * The engine's own rule roster. The dashboard used to carry a hand-
   * copied name → category map and classify "safety" by name substrings
   * (pii / injection / blocklist / stub), which is how a
   * no_hallucination_markers failure — a safety rule since v0.5.0 — drilled
   * through to the wrong filter on two charts. Serving the roster from
   * `rulesByType` means a rule added to a bundle is categorised correctly
   * on the dashboard without a second edit. Not tenant-scoped: built-ins
   * are process-global.
   */
  router.get('/rules/builtin', (_req, res) => {
    res.json({ rules: listBuiltInRules() });
  });

  router.get('/rules/custom', (req, res) => {
    const tenantId = requireTenant(req);
    const rules = opts.customRuleStore.list(tenantId);
    res.json({ rules });
  });

  router.post('/rules/custom', async (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const input = DeploySchema.parse(req.body);

      // Server overrides the inner definition's `name` so it always matches the
      // user-facing rule name. Avoids confusion when the rule name and the
      // inner definition's check name diverge.
      const definition: CustomRuleDefinition = {
        ...input.definition,
        name: input.name,
      };

      /*
       * Same-name redeploy — the SAME helper deploy_rule uses, so the
       * dashboard cannot accept a duplicate the tool refuses (two rules
       * with one name both fire with indistinguishable rule_results).
       * Throws before anything is written when the name is taken and
       * `replace` is false; with `replace: true` the earlier rule(s) are
       * deleted (audit rows kept, unregistered from the engine) beforehand.
       */
      const replaced = retireSameNamedRules(
        opts.customRuleStore,
        opts.evalEngine,
        tenantId,
        input.name,
        input.replace,
        'local',
      );

      const rule = opts.customRuleStore.deploy(tenantId, {
        name: input.name,
        description: input.description,
        evalType: input.evalType,
        severity: input.severity,
        definition,
        sourceMomentId: input.sourceMomentId,
      });

      // Register the new rule with the live engine so it fires on subsequent
      // evaluate_output calls without requiring a server restart. Registered
      // under its rule id so the delete paths can hot-remove it. The engine
      // is process-global in v0.4 — Cloud multi-tenant engine wiring is a
      // v0.5 architectural item. Severity rides along: high/critical makes
      // the rule hard-failing (same as the MCP deploy path and boot loading).
      opts.evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);

      res.status(201).json({
        rule,
        ...(replaced.length > 0 ? { replaced, warning: replacedRulesWarning(input.name, replaced) } : {}),
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid rule definition', details: err.issues });
        return;
      }
      if (err instanceof DuplicateRuleNameError) {
        // 409, not 400: the body was valid — the name is taken.
        res.status(409).json({
          error: err.message,
          existing: err.existing.map((r) => ({ id: r.id, evalType: r.evalType, severity: r.severity, enabled: r.enabled })),
        });
        return;
      }
      throw err;
    }
  });

  /*
   * Enable / disable without deleting. delete_rule's and list_rules' tool
   * descriptions have pointed users at "the dashboard's toggle affordance"
   * since v0.4; until now nothing — no route, no UI call, no MCP tool —
   * invoked the store's setEnabled, so the advertised affordance did not
   * exist. The engine is kept in lockstep the same way delete is: a
   * disabled rule stops firing on the very next evaluate_output call, and a
   * re-enabled one fires again, no restart in either direction.
   */
  router.patch('/rules/custom/:id', (req, res) => {
    try {
      const tenantId = requireTenant(req);
      const { enabled } = ToggleSchema.parse(req.body);
      const existing = opts.customRuleStore.get(tenantId, req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }
      if (existing.enabled === enabled) {
        // Idempotent: the engine already matches the store; touching it
        // would double-register or no-op-unregister.
        res.json({ rule: existing });
        return;
      }
      const rule = opts.customRuleStore.setEnabled(tenantId, req.params.id, enabled);
      if (!rule) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }
      if (enabled) {
        opts.evalEngine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);
      } else {
        opts.evalEngine.unregisterRule(rule.id);
      }
      res.json({ rule });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid toggle request', details: err.issues });
        return;
      }
      throw err;
    }
  });

  router.delete('/rules/custom/:id', (req, res) => {
    const tenantId = requireTenant(req);
    const removed = opts.customRuleStore.delete(tenantId, req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    // Hot-remove from the live engine too, so the deleted rule stops firing
    // on the very next evaluate_output call — no restart needed. No-op when
    // the rule was never registered in this process (e.g. deployed under a
    // different tenant, or the id predates id-tracked registration).
    opts.evalEngine.unregisterRule(req.params.id);
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

/** Verdict of the proposed rule against the caller's own sample text. */
export interface SamplePreview {
  passed: boolean;
  score: number;
  message: string;
  skipped: boolean;
  skipReason?: string;
}

async function previewRule(
  tenantId: TenantId,
  input: z.infer<typeof PreviewSchema>,
  storage: IStorageAdapter,
): Promise<RulePreviewResult & { sample?: SamplePreview }> {
  const since = new Date(Date.now() - input.windowDays * 24 * 60 * 60 * 1000).toISOString();
  const traceResult = await storage.queryTraces(tenantId, {
    filter: { since },
    limit: input.maxTraces,
    sort_by: 'timestamp',
    sort_order: 'desc',
  });

  // definition.name is optional on the wire (the deploy path overwrites it
  // anyway); the evaluator wants a name for its result rows.
  const rule = createCustomRule({ ...input.definition, name: input.definition.name ?? 'preview' });

  // Sanity-probe the rule against an empty input. A broken DEFINITION —
  // invalid regex, pattern too long, ReDoS rejection, missing required
  // config — comes back marked configInvalid (custom.ts routes every
  // compile/config failure through configError, which also sets skipped,
  // so probing passed/message here would never fire). Config errors depend
  // only on the definition, never the trace, so one probe hit means every
  // trace would "skip" identically. Surface as a 422 so the UI can show
  // the error instead of a misleading "N traces would skip."
  const probe = rule.evaluate({ output: '' });
  if (probe.configInvalid) {
    const err = new Error(probe.message) as Error & { status?: number };
    err.status = 422;
    throw err;
  }

  let wouldPass = 0;
  let wouldFail = 0;
  let wouldSkip = 0;
  const examples: RulePreviewResult['examples'] = [];

  /*
   * ONE regex budget for the whole preview, not one per trace. This loop
   * runs a caller-supplied pattern against up to maxTraces (cap 5000)
   * seedable outputs on the main thread — with no shared breaker, a
   * sandbox-defeating pattern×output pair cost ~142ms per trace, ~12
   * minutes of server freeze at the cap, from one self-serve request
   * (the deploy probe guesses payloads and cannot catch every such
   * pattern). Sharing the breaker means at most 3 traces pay the budget;
   * the rest report wouldSkip instantly — and "this pattern gets
   * defeated" is exactly the answer the rule author needs from a preview.
   */
  const regexBudget = { breaches: 0 };

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
      regexBudget,
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

  /*
   * The sample gets its own budget: it is the one output the author is
   * actually asking about, and it must not inherit a breaker the replay
   * may already have opened.
   */
  let sample: SamplePreview | undefined;
  if (input.sampleOutput !== undefined) {
    const r = rule.evaluate({ output: input.sampleOutput, regexBudget: { breaches: 0 } });
    sample = {
      passed: r.passed,
      score: r.score,
      message: r.message,
      skipped: r.skipped === true,
      ...(r.skipReason !== undefined ? { skipReason: r.skipReason } : {}),
    };
  }

  return {
    tracesEvaluated: traceResult.traces.length,
    wouldFail,
    wouldPass,
    wouldSkip,
    examples,
    windowSinceIso: since,
    ...(sample ? { sample } : {}),
  };
}
