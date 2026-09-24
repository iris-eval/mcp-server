import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT, type TenantId } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { advertisedOutput } from './advertise.js';
import { guarded, respond } from './respond.js';
import { compareRuns, RULE_ALPHA } from '../eval/compare.js';
import { irisError } from './errors.js';

/*
 * "Did my change make it worse?"
 *
 * Every competitor answers this from a test suite you wrote, which means the
 * answer only covers what you thought to write down. This answers it from
 * the traces Iris already holds — deterministically, locally, and without a
 * model call.
 *
 * The design decision that shows up in the response shape: this tool is
 * allowed to say it cannot tell, and it says so with a number attached.
 * `worse` and `better` are separate booleans rather than one direction
 * field precisely so that "neither" is representable and is the default.
 * Since arc 7 (D-6b) there is a third answer, `equivalent_within`, which is
 * not the absence of a difference but a positive finding with a margin.
 */

const runSummarySchema = z.looseObject({
  run_id: z.string(),
  n: z.number().describe('evaluations counted, one per trace (most recent wins)'),
  passed: z.number(),
  rate: z.number().nullable().describe('pass rate, null when the run is empty'),
  interval: z.looseObject({ lo: z.number(), hi: z.number() }).nullable().describe('95% Wilson interval on that rate'),
  agent_names: z.array(z.string()),
  engine_versions: z.array(z.string()),
  ruleset_hashes: z.array(z.string()),
  config_hashes: z.array(z.string()),
  superseded: z.number().describe('older evaluations collapsed away, so a re-run case is not counted twice'),
});

const differenceSchema = z.looseObject({ delta: z.number(), lo: z.number(), hi: z.number(), significant: z.boolean() });

const ruleDeltaSchema = z.looseObject({
  rule: z.string(),
  failed_before: z.number(),
  failed_after: z.number(),
  delta: z.number(),
  difference: differenceSchema.nullable().describe("this rule's pass-rate difference, 95% Newcombe; null when a side is empty"),
  test: z.enum(['mcnemar-exact', 'newcombe-z']).nullable().describe("behind p: McNemar exact on this rule's discordant pairs when paired, else a Newcombe z"),
  p: z.number().nullable().describe('one-sided in the regression direction'),
  q: z.number().nullable().describe('Benjamini–Hochberg over every rule tested; read this, not p'),
  worse: z.boolean().describe(`true ONLY at q ≤ ${RULE_ALPHA} in the regression direction`),
});

const equivalenceSchema = z.looseObject({
  margin: z.number().describe('δ, a pass-rate difference'),
  margin_source: z.enum(['caller', 'smallest-detectable']).describe('supplied, or the smallest detectable difference'),
  interval: z.looseObject({ lo: z.number(), hi: z.number() }).describe('the 90% Newcombe interval on the difference'),
  holds: z.boolean().describe('the whole 90% interval lies inside (−δ, +δ)'),
});

const discordantSchema = z.looseObject({
  case_key: z.string(),
  before: z.looseObject({ eval_id: z.string(), trace_id: z.string().nullable(), passed: z.boolean() }),
  after: z.looseObject({ eval_id: z.string(), trace_id: z.string().nullable(), passed: z.boolean() }),
  direction: z.enum(['regressed', 'recovered']).describe('regressed: passed before, failed after'),
  rules: z.array(z.looseObject({ rule: z.string(), before: z.boolean(), after: z.boolean() })).describe('the rules whose pass/fail differ'),
});

export const compareRunsOutputSchema = z.looseObject({
  comparable: z.boolean().describe('false when the runs measure different things'),
  incomparable_because: z.array(z.string()).describe('one sentence per reason; empty when comparable'),
  forced: z.boolean().describe('true when force compared across a boundary'),
  method: z.enum(['paired-mcnemar', 'unpaired-newcombe', 'none']).describe('paired when the runs share case keys'),
  before: runSummarySchema.describe('the baseline run and its provenance'),
  after: runSummarySchema.describe('the run compared against it'),
  difference: differenceSchema.nullable().describe('after minus before, 95% Newcombe interval'),
  paired: z
    .looseObject({ method: z.string(), b: z.number(), c: z.number(), concordant: z.number(), pairs: z.number(), p_value: z.number(), significant: z.boolean() })
    .nullable()
    .describe('McNemar exact on the disagreeing cases; null unpaired'),
  worse: z.boolean().describe('true ONLY when a one-sided test shows the rate fell; NOT better inverted'),
  better: z.boolean().describe('the same, in the other direction'),
  smallest_detectable: z
    .number()
    .nullable()
    .describe('when neither: the smallest change these cases could detect'),
  equivalent_within: equivalenceSchema.nullable().describe('equivalent within a margin; null when a run is empty'),
  rules_tested: z.number().describe('rules the per-rule tests covered'),
  regressions: z.array(ruleDeltaSchema).describe('rules failing more often, worst first, with p and q'),
  improvements: z.array(ruleDeltaSchema).describe('rules failing less often, kept separate from regressions'),
  discordant: z.array(discordantSchema).describe('the paired cases that disagreed, regressions first, with the rules that flipped'),
  discordant_total: z.number().describe('how many disagreed; the list is capped'),
  summary: z.string().describe('the finding in prose, including what it could NOT establish'),
  dataset: z
    .looseObject({ id: z.string(), label: z.string(), version: z.number(), cases: z.number(), matched_before: z.number(), matched_after: z.number() })
    .nullable()
    .describe('the dataset both runs were restricted to; null when none'),
});

export function registerCompareRunsTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'compare_runs',
    {
      title: 'Compare Runs',
      description: describeTool({
        summary:
          'Did this change make the agent worse? Compares two runs: worse, better, equivalent, or too little evidence to tell.',
        does:
          'Pairs cases by case_key (McNemar exact), else uses a Newcombe interval; flags a rule worse only after a multiple-testing correction. Refuses runs that measure different things unless force is true. Local, no model call.',
        whenNot:
          'To score one output (evaluate_output). As a gate: it reports; blocking is your policy.',
        returns: compareRunsOutputSchema,
        errors:
          'IRIS_INVALID_ARGUMENT (empty run id, no baseline, bad margin or dataset); IRIS_STORAGE_ERROR. ' + ERROR_ENVELOPE_SENTENCE,
        siblings: {
          log_trace: 'record into a run',
          get_traces: 'find a run\'s traces',
        },
      }),
      inputSchema: strictInput(
        {
          before: z.string().min(1).optional().describe('the baseline run id (`run` on log_trace); omit to use the run pinned with PATCH /api/v1/runs/:id'),
          after: z.string().min(1).describe('the run id to compare against it'),
          force: z
            .boolean()
            .optional()
            .describe('Compare even when the runs are not strictly comparable; the response still names what changed'),
          equivalence_margin: z
            .number()
            .gt(0)
            .lte(1)
            .optional()
            .describe('δ for the equivalence test, as a difference in pass rate (0.05 = five points). Absent: the smallest difference these sizes could detect, and the response says so'),
          dataset: z
            .string()
            .min(1)
            .optional()
            .describe('Restrict both runs to the case keys of this dataset (its id or label); every count then covers only those cases'),
        },
      ),
      outputSchema: advertisedOutput(compareRunsOutputSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args) => respond(compareRunsOutputSchema, await compareStoredRuns(storage, LOCAL_TENANT, args))),
  );
}

export interface CompareStoredRunsArgs {
  /** Omitted: the run pinned as the baseline (arc 9, N-14). */
  before?: string;
  after: string;
  force?: boolean;
  equivalence_margin?: number;
  /** A dataset id or label: only rows whose case key is in it are compared (arc 8, R-8). */
  dataset?: string;
}

/**
 * The handler behind `compare_runs`, shared with `POST /api/v1/compare`
 * (arc 7, D-5): reads each run's evaluations (most recent per trace), runs
 * the comparison, and shapes it exactly as the tool's output schema says.
 * One implementation, one shape, two doors.
 */
export async function compareStoredRuns(
  storage: IStorageAdapter,
  tenantId: TenantId,
  args: CompareStoredRunsArgs,
): Promise<z.infer<typeof compareRunsOutputSchema>> {
  const beforeId = args.before ?? (await storage.getBaselineRun(tenantId));
  if (beforeId === null || beforeId === undefined) {
    throw irisError('IRIS_INVALID_ARGUMENT', 'No run is pinned as the baseline and `before` was not given.', {
      field: 'before',
      recovery: ['Pass before (the run id to treat as the baseline), or pin one with PATCH /api/v1/runs/:id { "baseline": true }.'],
      retryable: false,
    });
  }
  const [allBefore, allAfter] = await Promise.all([
    storage.getRunResults(tenantId, beforeId),
    storage.getRunResults(tenantId, args.after),
  ]);
  /*
   * A dataset restricts both sides to the case keys the reader chose (arc 8,
   * R-8). No statistic changes: the same pairing, the same tests, over a
   * chosen set of cases. Rows with no case key cannot be in a dataset and
   * are dropped with the rest.
   */
  let beforeRows = allBefore;
  let afterRows = allAfter;
  let dataset: z.infer<typeof compareRunsOutputSchema>['dataset'] = null;
  if (args.dataset !== undefined) {
    const found = await storage.getDataset(tenantId, args.dataset);
    if (!found) {
      throw irisError('IRIS_INVALID_ARGUMENT', `No dataset has the id or label "${args.dataset}".`, {
        field: 'dataset',
        recovery: ['List them at GET /api/v1/datasets, or create one with POST /api/v1/datasets from the case keys of a run.'],
        retryable: false,
      });
    }
    const keys = new Set(found.caseKeys.map((k) => k.caseKey));
    beforeRows = allBefore.filter((r) => r.caseKey !== null && keys.has(r.caseKey));
    afterRows = allAfter.filter((r) => r.caseKey !== null && keys.has(r.caseKey));
    dataset = { id: found.id, label: found.label, version: found.version, cases: found.cases, matched_before: beforeRows.length, matched_after: afterRows.length };
  }
  const c = compareRuns(beforeId, beforeRows, args.after, afterRows, { force: args.force === true, equivalenceMargin: args.equivalence_margin });

  const summary = (s: typeof c.before): z.infer<typeof runSummarySchema> => ({
    run_id: s.runId,
    n: s.n,
    passed: s.passed,
    rate: s.rate,
    interval: s.interval,
    agent_names: s.agentNames,
    engine_versions: s.engineVersions,
    ruleset_hashes: s.rulesetHashes,
    config_hashes: s.configHashes,
    superseded: s.superseded,
  });
  const rule = (r: (typeof c.regressions)[number]): z.infer<typeof ruleDeltaSchema> => ({
    rule: r.rule,
    failed_before: r.failedBefore,
    failed_after: r.failedAfter,
    delta: r.delta,
    // Spread: the output schema is loose (index-signed) and an interface value is not assignable to it as-is.
    difference: r.difference ? { ...r.difference } : null,
    test: r.test,
    p: r.p,
    q: r.q,
    worse: r.worse,
  });

  return {
    comparable: c.comparable,
    incomparable_because: c.incomparableBecause,
    forced: c.forced,
    method: c.method,
    before: summary(c.before),
    after: summary(c.after),
    difference: c.difference ? { ...c.difference } : null,
    paired: c.paired
      ? { method: c.paired.method, b: c.paired.b, c: c.paired.c, concordant: c.paired.concordant, pairs: c.paired.pairs, p_value: c.paired.pValue, significant: c.paired.significant }
      : null,
    worse: c.worse,
    better: c.better,
    smallest_detectable: c.smallestDetectable,
    equivalent_within: c.equivalentWithin
      ? { margin: c.equivalentWithin.margin, margin_source: c.equivalentWithin.marginSource, interval: { ...c.equivalentWithin.interval }, holds: c.equivalentWithin.holds }
      : null,
    rules_tested: c.rulesTested,
    regressions: c.regressions.map(rule),
    improvements: c.improvements.map(rule),
    discordant: c.discordant.map((d) => ({
      case_key: d.caseKey,
      before: { eval_id: d.before.evalId, trace_id: d.before.traceId, passed: d.before.passed },
      after: { eval_id: d.after.evalId, trace_id: d.after.traceId, passed: d.after.passed },
      direction: d.direction,
      rules: d.rules.map((r) => ({ ...r })),
    })),
    discordant_total: c.discordantTotal,
    summary: dataset
      ? `Restricted to dataset "${dataset.label}" (${dataset.cases} case${dataset.cases === 1 ? '' : 's'}): ${dataset.matched_before} row${dataset.matched_before === 1 ? '' : 's'} of ${args.before} and ${dataset.matched_after} of ${args.after} matched. ${c.summary}`
      : c.summary,
    dataset,
  };
}
