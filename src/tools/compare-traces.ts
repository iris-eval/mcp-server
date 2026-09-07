import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { guarded, respond } from './respond.js';
import { clusterBootstrap, wilson } from '../eval/stats.js';

/*
 * How reliably does the agent answer THIS question?
 *
 * The other half of comparison, and the half people get wrong. Asked the
 * same question ten times, an agent that passes eight is not "80% correct"
 * with the confidence eighty of a hundred would give you — it is ONE
 * question answered eight times, and the interval has to say so.
 *
 * That is why the run-level rate here comes from a cluster bootstrap over
 * CASES rather than from pooling every attempt: pooling ten repeats of five
 * questions claims n = 50 and reports an interval built on fifty
 * independent observations, which is a claim the data never made. On real
 * numbers the honest interval comes out roughly twice as wide, and that
 * width is the whole point of computing it.
 */

const caseRowSchema = z.looseObject({
  case_key: z.string(),
  attempts: z.number(),
  passed: z.number(),
  rate: z.number(),
  interval: z.looseObject({ lo: z.number(), hi: z.number() }).nullable().describe('95% Wilson interval on this case'),
  flaky: z.boolean().describe('answered both ways across its attempts'),
  runs: z.array(z.string()).describe('the runs these attempts came from'),
});

export const compareTracesOutputSchema = z.looseObject({
  case_key: z.string().nullable().describe('set when one case was asked for'),
  cases: z.number().describe('distinct questions counted'),
  attempts: z.number().describe('total evaluations, repeats included'),
  overall: z
    .looseObject({ rate: z.number(), lo: z.number(), hi: z.number() })
    .nullable()
    .describe('pass rate by a cluster bootstrap over CASES: repeats of one question are one question'),
  pooled: z
    .looseObject({ rate: z.number(), lo: z.number(), hi: z.number() })
    .nullable()
    .describe('the naive reading, pooling attempts as independent; shown beside the honest one'),
  flaky_cases: z.array(caseRowSchema).describe('cases answered both ways, least reliable first'),
  by_case: z.array(caseRowSchema).describe('every case, least reliable first'),
  summary: z.string().describe('the finding in prose'),
});

export function registerCompareTracesTool(server: McpServer, storage: IStorageAdapter): void {
  server.registerTool(
    'compare_traces',
    {
      title: 'Compare Traces',
      description: describeTool({
        summary: 'How reliably does the agent answer the same question? Groups stored evaluations by case and reports per-case pass rates, flakiness, and an interval that respects repeats.',
        does:
          'Groups every evaluation by case_key (supplied on log_trace, or derived from the input) and reports how often each case passed, with a 95% Wilson interval per case. ' +
          'A case answered both ways is FLAKY, least reliable first: that is where determinism is worth buying, and a single run cannot show it. ' +
          'The overall rate uses a cluster bootstrap over CASES, not pooled attempts — ten repeats of one question are one question, and pooling claims an n the data never earned. The pooled figure is shown beside it. ' +
          'Deterministic, local, no model call.',
        whenNot:
          'To compare two runs against each other (compare_runs). To score an output (evaluate_output). To read the traces themselves (get_traces).',
        returns: compareTracesOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR when the database cannot be read. No matching evaluations is NOT an error: cases is 0 and the summary says nothing matched. ' +
          ERROR_ENVELOPE_SENTENCE,
        siblings: {
          compare_runs: 'compare two runs against each other',
          log_trace: 'record an execution with a case_key',
          get_traces: 'read the traces themselves',
        },
      }),
      inputSchema: strictInput({
        run: z.string().optional().describe('narrow to one run; omit to read every evaluation that carries a case key'),
        case_key: z.string().optional().describe('narrow to a single case — the fastest way to ask "is this one question flaky?"'),
        min_attempts: z.number().int().min(1).optional().describe('ignore cases asked fewer than this many times (default 1). A case asked once cannot be shown to be flaky'),
      }),
      outputSchema: compareTracesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      const rows = await storage.getCaseResults(LOCAL_TENANT, { run: args.run, caseKey: args.case_key });
      const minAttempts = args.min_attempts ?? 1;

      const grouped = new Map<string, { passed: number; attempts: number; runs: Set<string> }>();
      for (const r of rows) {
        if (r.caseKey === null) continue;
        const g = grouped.get(r.caseKey) ?? { passed: 0, attempts: 0, runs: new Set<string>() };
        g.attempts += 1;
        if (r.passed) g.passed += 1;
        if (r.runId) g.runs.add(r.runId);
        grouped.set(r.caseKey, g);
      }

      const cases = [...grouped.entries()]
        .filter(([, g]) => g.attempts >= minAttempts)
        .map(([case_key, g]) => {
          const w = wilson(g.passed, g.attempts);
          return {
            case_key,
            attempts: g.attempts,
            passed: g.passed,
            rate: g.passed / g.attempts,
            interval: w ? { lo: w.lo, hi: w.hi } : null,
            flaky: g.passed > 0 && g.passed < g.attempts,
            runs: [...g.runs].sort(),
          };
        })
        .sort((a, b) => a.rate - b.rate || a.case_key.localeCompare(b.case_key));

      const attempts = cases.reduce((n, c) => n + c.attempts, 0);
      const totalPassed = cases.reduce((n, c) => n + c.passed, 0);
      const boot = clusterBootstrap(cases.map((c) => ({ passed: c.passed, total: c.attempts })), `cases:${args.run ?? 'all'}:${args.case_key ?? 'all'}`);
      const pooledW = attempts > 0 ? wilson(totalPassed, attempts) : null;
      const flaky = cases.filter((c) => c.flaky);

      const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
      const summary =
        cases.length === 0
          ? 'No evaluations carry a case key for that filter. Pass case_key on log_trace, or send an input — a key is derived from it — and the repeats become comparable.'
          : [
              `${cases.length} case${cases.length === 1 ? '' : 's'} across ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
              boot ? `Pass rate ${pct(boot.rate)}, 95% interval [${pct(boot.lo)}, ${pct(boot.hi)}] over CASES.` : '',
              pooledW && boot && pooledW.hi - pooledW.lo < boot.hi - boot.lo
                ? `Pooling every attempt as independent would report [${pct(pooledW.lo)}, ${pct(pooledW.hi)}] — narrower than the data supports, because repeats of one question are one question.`
                : '',
              flaky.length > 0
                ? `${flaky.length} case${flaky.length === 1 ? '' : 's'} answered BOTH ways, least reliable first: ${flaky.slice(0, 3).map((c) => `${c.case_key} (${c.passed}/${c.attempts})`).join(', ')}. A single run cannot show this.`
                : 'No case was answered both ways, so nothing here is visibly flaky.',
            ]
              .filter(Boolean)
              .join(' ');

      return respond(compareTracesOutputSchema, {
        case_key: args.case_key ?? null,
        cases: cases.length,
        attempts,
        overall: boot,
        pooled: pooledW ? { rate: totalPassed / attempts, lo: pooledW.lo, hi: pooledW.hi } : null,
        flaky_cases: flaky,
        by_case: cases,
        summary,
      });
    }),
  );
}
