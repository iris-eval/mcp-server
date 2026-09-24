import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IStorageAdapter } from '../types/query.js';
import type { EvalEngine } from '../eval/engine.js';
import { costHistoryFor } from '../eval/ingest.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import { strictInput } from './strict-input.js';
import { describeTool, ERROR_ENVELOPE_SENTENCE } from './describe.js';
import { advertisedOutput } from './advertise.js';
import { guarded, respond } from './respond.js';
import { irisError } from './errors.js';
import { insertLinkedEvalResult } from './trace-link.js';
import type { RuleChangesSinceStart } from '../custom-rule-store.js';

/*
 * Score a run again under today's rules.
 *
 * The reason this is a tool rather than a loop the caller writes: a
 * comparison is only meaningful when both sides were judged by the same
 * ruleset, and the most common way to get that wrong is to change a rule and
 * compare yesterday's verdicts with today's. That comparison attributes a
 * change in the RULES to a change in the AGENT — the one confusion this arc
 * exists to prevent — and nothing about the numbers reveals it.
 *
 * So the re-evaluation writes into a NEW run, stamped `reevaluation_of`, and
 * leaves the original untouched. You then have two runs that differ in
 * exactly one way, and `compare_runs` can say which. Overwriting the old
 * verdicts in place would destroy the very baseline the comparison needs.
 *
 * It re-runs the deterministic rules only. No provider is called and nothing
 * is spent, which is what makes re-scoring a thousand stored traces a thing
 * you can do without thinking about it.
 */

export const evaluateRunsOutputSchema = z.looseObject({
  source_run: z.string().describe('the run whose traces were re-scored'),
  run: z.string().describe('the new run holding the new verdicts; the source run is left untouched'),
  ruleset_hash: z.string().describe('the ruleset every new verdict was produced under'),
  traces: z.number().describe('traces in the source run'),
  evaluated: z.number().describe('traces scored on this call'),
  already_current: z.number().describe('traces skipped because their latest verdict already came from this ruleset'),
  failed: z.array(z.looseObject({ trace_id: z.string(), reason: z.string() })).describe('traces that could not be scored, each with why'),
  passed: z.number().describe('how many of the new verdicts passed'),
  summary: z.string().describe('what happened, and what to do with it'),
  rules_changed: z
    .looseObject({ count: z.number().int().positive(), last_change_at: z.string(), since: z.string(), audit: z.literal('iris://audit') })
    .optional()
    .describe('present when deployed custom rules changed since the server started, as on evaluate_output; each change is in iris://audit'),
});

export interface EvaluateRunsOptions {
  /** Deployed-rule changes since the server started, for rules_changed. */
  rulesChanged?: () => RuleChangesSinceStart | null;
}

export function registerEvaluateRunsTool(
  server: McpServer,
  storage: IStorageAdapter,
  evalEngine: EvalEngine,
  options?: EvaluateRunsOptions,
): void {
  server.registerTool(
    'evaluate_runs',
    {
      title: 'Evaluate Runs',
      description: describeTool({
        summary:
          'Re-score every trace in a run under the current rules into a new run, so a rules change is compared, not overwritten.',
        does:
          'Writes the verdicts into a NEW run; the source run is never modified. Traces already scored under the current ruleset are skipped, so a repeat call does no work. Local, no model call.',
        whenNot:
          'To score a new execution (log_trace, then evaluate_output).',
        returns: evaluateRunsOutputSchema,
        errors:
          'IRIS_INVALID_ARGUMENT (empty run id, or the target run holds verdicts); IRIS_UNKNOWN_TRACE (source run empty); IRIS_STORAGE_ERROR. Unscorable traces are listed in failed. ' + ERROR_ENVELOPE_SENTENCE,
        siblings: {
          compare_runs: 'compare the two runs after',
          evaluate_output: 're-score one trace',
          get_traces: 'read a run',
        },
      }),
      inputSchema: strictInput({
        run: z.string().min(1).describe('the run to re-score — whatever you passed as `run` on log_trace'),
        into: z
          .string()
          .min(1)
          .optional()
          .describe('Run id for the new verdicts; defaults to <run>+reeval-<ruleset hash>, stable across repeats'),
        label: z.string().optional().describe('a name for the new run, shown in listings'),
      }),
      outputSchema: advertisedOutput(evaluateRunsOutputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false, // Writes new verdicts into a new run; the source run is untouched.
        idempotentHint: true,   // A trace already scored under this ruleset is skipped, so a second call is a no-op.
        openWorldHint: false,
      },
    },
    guarded(async (args) => {
      const rulesetHash = evalEngine.rulesetHashForAll();
      const target = args.into ?? `${args.run}+reeval-${rulesetHash.slice(0, 12)}`;

      if (target === args.run) {
        throw irisError('IRIS_INVALID_ARGUMENT', 'A re-evaluation cannot write into the run it is re-evaluating — that would destroy the baseline the comparison needs.', {
          field: 'into',
          recovery: ['Leave `into` unset to use the default target, or name a run id that differs from `run`.'],
          retryable: false,
        });
      }

      const state = await storage.getRunTraceEvaluationState(LOCAL_TENANT, args.run, rulesetHash);
      if (state.length === 0) {
        throw irisError('IRIS_UNKNOWN_TRACE', `No traces are tagged with run "${args.run}".`, {
          field: 'run',
          recovery: [
            'Check the run id with the runs listing, or pass `run` on log_trace when recording executions so they form a run.',
          ],
          retryable: false,
        });
      }

      const alreadyCurrent = state.filter((s) => s.evaluatedUnderRuleset).length;
      const todo = state.filter((s) => !s.evaluatedUnderRuleset);

      await storage.upsertRun(LOCAL_TENANT, { runId: target, label: args.label ?? null, reevaluationOf: args.run });

      const failed: Array<{ trace_id: string; reason: string }> = [];
      let passed = 0;
      let evaluated = 0;

      for (const { traceId } of todo) {
        const trace = await storage.getTrace(LOCAL_TENANT, traceId);
        if (trace === null) {
          failed.push({ trace_id: traceId, reason: 'the trace was deleted between listing and reading' });
          continue;
        }
        if (trace.output === undefined || trace.output === null || trace.output === '') {
          // Not an error and not silent: a trace with nothing to score is a
          // real thing to know about a run, so it is reported by name.
          failed.push({ trace_id: traceId, reason: 'the trace recorded no output, so there is nothing to score' });
          continue;
        }

        /*
         * Spans are read only when the trace carried no tool_calls, matching
         * evaluate_output: the step layer's precedence is whole-source, so a
         * stored tool_calls wins outright and the query would be wasted.
         */
        const spans =
          trace.tool_calls === undefined || trace.tool_calls.length === 0
            ? await storage.getSpansByTraceId(LOCAL_TENANT, traceId)
            : undefined;

        const result = await evalEngine.evaluateAll({
          output: trace.output,
          input: trace.input,
          costUsd: trace.cost_usd,
          costHistory: await costHistoryFor(storage, LOCAL_TENANT, trace),
          tokenUsage: trace.token_usage,
          toolCalls: trace.tool_calls,
          spans,
          tools: trace.tools,
        });
        result.trace_id = traceId;
        result.run_id = target;
        await insertLinkedEvalResult(storage, LOCAL_TENANT, result);
        evaluated += 1;
        if (result.passed) passed += 1;
      }

      const summary = [
        `Re-scored ${evaluated} of ${state.length} trace${state.length === 1 ? '' : 's'} from "${args.run}" into "${target}" under ruleset ${rulesetHash.slice(0, 12)}.`,
        alreadyCurrent > 0
          ? `${alreadyCurrent} already had a verdict from this ruleset and ${alreadyCurrent === 1 ? 'was' : 'were'} left alone.`
          : '',
        failed.length > 0 ? `${failed.length} could not be scored; each is listed with its reason.` : '',
        evaluated > 0
          ? `${passed} of the ${evaluated} new verdict${evaluated === 1 ? '' : 's'} passed. Compare "${args.run}" against "${target}" to see what the rules change did — the executions are identical, so any difference is the rules.`
          : 'Nothing was re-scored, so there is nothing new to compare.',
      ]
        .filter(Boolean)
        .join(' ');

      // The re-score ran under the rules as they are now; if they moved
      // while the server ran, the answer says so, as a verdict does.
      const rulesChanged = options?.rulesChanged?.();
      return respond(evaluateRunsOutputSchema, {
        source_run: args.run,
        run: target,
        ruleset_hash: rulesetHash,
        traces: state.length,
        evaluated,
        already_current: alreadyCurrent,
        failed,
        passed,
        summary,
        ...(rulesChanged ? { rules_changed: rulesChanged } : {}),
      });
    }),
  );
}
