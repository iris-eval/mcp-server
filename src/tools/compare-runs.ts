import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT, type TenantId } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { guarded, respond } from './respond.js';
import { compareRuns, RULE_ALPHA } from '../eval/compare.js';

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

export const compareRunsOutputSchema = z.looseObject({
  comparable: z.boolean().describe('false when the runs measure different things'),
  incomparable_because: z.array(z.string()).describe('one sentence per reason; empty when comparable'),
  forced: z.boolean().describe('true when force compared across a boundary'),
  method: z.enum(['paired-mcnemar', 'unpaired-newcombe', 'none']).describe('paired when the runs share case keys; paired sees changes unpaired cannot'),
  before: runSummarySchema.describe('the baseline run and its provenance'),
  after: runSummarySchema.describe('the run compared against it'),
  difference: differenceSchema.nullable().describe('after minus before, 95% Newcombe interval'),
  paired: z
    .looseObject({ method: z.string(), b: z.number(), c: z.number(), concordant: z.number(), pairs: z.number(), p_value: z.number(), significant: z.boolean() })
    .nullable()
    .describe('McNemar exact on the disagreeing cases; null when nothing paired'),
  worse: z.boolean().describe('true ONLY when the evidence excludes no change; NOT the inverse of better'),
  better: z.boolean().describe('the same, in the other direction'),
  smallest_detectable: z
    .number()
    .nullable()
    .describe('when neither: the smallest change this many cases could have detected'),
  equivalent_within: equivalenceSchema.nullable().describe('the third answer: equivalent within a margin; null when a run is empty'),
  rules_tested: z.number().describe('rules the per-rule tests covered'),
  regressions: z.array(ruleDeltaSchema).describe('rules failing more often, worst first, with p and q'),
  improvements: z.array(ruleDeltaSchema).describe('rules failing less often, kept separate from regressions'),
  summary: z.string().describe('the finding in prose, including what it could NOT establish'),
});

export function registerCompareRunsTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'compare_runs',
    {
      title: 'Compare Runs',
      description: describeTool({
        summary: 'Did this change make the agent worse? Compares two runs of stored evaluations and answers with an interval — or says the data cannot tell, or that the runs are equivalent within a margin.',
        does:
          'Reads every evaluation in each run (most recent per trace) and compares their pass rates. ' +
          'When the runs share case keys it PAIRS them and runs McNemar exact on the cases that disagreed, which sees a change an unpaired test of the same data cannot; otherwise it uses a Newcombe interval on two independent proportions. ' +
          'Says "not enough evidence" — with the smallest change that many cases could have seen — rather than guessing. ' +
          `Tests each rule one-sided and corrects the p-values together (Benjamini–Hochberg): a rule is marked worse only at q ≤ ${RULE_ALPHA}. ` +
          'States equivalence within equivalence_margin (default: the smallest detectable difference) when the 90% interval lies inside ±δ. ' +
          'Refuses runs that measure different things (ruleset, configuration, engine minor, agent), naming which; force compares anyway and still names what changed. ' +
          'Deterministic, local, no model call. Tag traces with run and case_key on log_trace.',
        whenNot:
          'To score one output (evaluate_output). To find the traces themselves (get_traces). To gate a deploy automatically: this tool reports, and whether a difference should block is your policy, not ours.',
        returns: compareRunsOutputSchema,
        errors:
          'IRIS_INVALID_ARGUMENT when a run id is empty or equivalence_margin is outside (0, 1]. IRIS_STORAGE_ERROR when the database cannot be read. ' +
          'An unknown or empty run is NOT an error: comparable is true, n is 0 and the summary says which run has no evaluations. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          log_trace: 'record an execution into a run',
          get_traces: 'find the traces in a run',
          evaluate_output: 'score one output',
        },
      }),
      inputSchema: strictInput(
        {
          before: z.string().min(1).describe('the run id to treat as the baseline — whatever you passed as `run` on log_trace'),
          after: z.string().min(1).describe('the run id to compare against it'),
          force: z
            .boolean()
            .optional()
            .describe('compare even when the runs are not strictly comparable (different ruleset, configuration, engine minor or agent). The response still names what changed — a pass rate that moved because the RULES changed is not a regression in your agent'),
          equivalence_margin: z
            .number()
            .gt(0)
            .lte(1)
            .optional()
            .describe('δ for the equivalence test, as a difference in pass rate (0.05 = five points). Absent: the smallest difference these sizes could detect, and the response says so'),
        },
      ),
      outputSchema: compareRunsOutputSchema,
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
  before: string;
  after: string;
  force?: boolean;
  equivalence_margin?: number;
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
  const [beforeRows, afterRows] = await Promise.all([
    storage.getRunResults(tenantId, args.before),
    storage.getRunResults(tenantId, args.after),
  ]);
  const c = compareRuns(args.before, beforeRows, args.after, afterRows, { force: args.force === true, equivalenceMargin: args.equivalence_margin });

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
    summary: c.summary,
  };
}
