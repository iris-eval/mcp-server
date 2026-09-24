import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { advertisedOutput } from './advertise.js';
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
  group_by: z.enum(['case_key', 'session']).describe('what a row is: a question, or a conversation'),
  question: z.string().nullable().describe('the one question the rates were read for, or null for the composed verdict'),
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
        summary:
          'How reliably does the agent answer the same question? Per-case pass rates, flaky cases, and an interval that respects repeats.',
        does:
          'Groups evaluations by case_key (or session) and reports each case\'s pass rate with a Wilson interval, the flaky cases least reliable first, and an overall rate bootstrapped over cases rather than pooled attempts. Deterministic, local, no model call.',
        whenNot:
          'To compare two runs (compare_runs). To score an output (evaluate_output).',
        returns: compareTracesOutputSchema,
        errors:
          'IRIS_STORAGE_ERROR. No matching evaluations is cases 0, not an error. ' + ERROR_ENVELOPE_SENTENCE,
        siblings: {
          compare_runs: 'compare two runs against each other',
          log_trace: 'record an execution with a case_key',
          get_traces: 'read the traces themselves',
        },
      }),
      inputSchema: strictInput({
        run: z.string().optional().describe('narrow to one run; omit to read every evaluation that carries a case key'),
        case_key: z.string().optional().describe('narrow to a single case — the fastest way to ask "is this one question flaky?"'),
        session: z.string().optional().describe('narrow to one session (the turns logged with that session_id)'),
        group_by: z.enum(['case_key', 'session']).optional().describe('case_key (default): repeats of one question; session: the turns of one conversation, so a session answered both ways reads as flaky and by_case rows carry session ids'),
        min_attempts: z.number().int().min(1).optional().describe('ignore cases asked fewer than this many times (default 1). A case asked once cannot be shown to be flaky'),
        question: z
          .enum(['safe_output', 'grounded', 'complete', 'relevant', 'task_completed', 'tool_use_correct', 'within_budget'])
          .optional()
          .describe('read the rate for ONE question: only evaluations that judged it count, and an attempt passes when every rule answering it passed — not the composed verdict'),
      }),
      outputSchema: advertisedOutput(compareTracesOutputSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      const groupBy = args.group_by ?? 'case_key';
      const rows = await storage.getCaseResults(LOCAL_TENANT, { run: args.run, caseKey: args.case_key, question: args.question, session: args.session, groupBy });
      const minAttempts = args.min_attempts ?? 1;

      const grouped = new Map<string, { passed: number; attempts: number; runs: Set<string> }>();
      for (const r of rows) {
        const key = groupBy === 'session' ? r.sessionId : r.caseKey;
        if (key === null) continue;
        const g = grouped.get(key) ?? { passed: 0, attempts: 0, runs: new Set<string>() };
        g.attempts += 1;
        if (r.passed) g.passed += 1;
        if (r.runId) g.runs.add(r.runId);
        grouped.set(key, g);
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
          ? groupBy === 'session'
            ? 'No evaluations carry a session id for that filter. Pass session_id on log_trace, or send it as the SEP-414 baggage member, and the turns of a conversation become comparable.'
            : 'No evaluations carry a case key for that filter. Pass case_key on log_trace, or send an input — a key is derived from it — and the repeats become comparable.'
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
        group_by: groupBy,
        question: args.question ?? null,
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
