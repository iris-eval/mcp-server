/*
 * `iris-eval ingest` — store traces from stdin or a file, evaluate them in
 * the same breath, and optionally fail a job on a named verdict basis.
 *
 * The third door, after the MCP tool and POST /api/v1/traces, and the one
 * that needs no daemon: a CI job pipes its traces in, a host hook pipes one
 * turn in. Every door validates through the one ingest schema and scores
 * through the one store-and-evaluate primitive, so the three cannot
 * disagree about what a trace is or what "evaluate on write" means.
 *
 * What it deliberately does NOT do: the boot-time retention sweep. The
 * server sweeps once at start; a hook that swept on every turn would be a
 * retention policy nobody set.
 */
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { loadConfig, type CliArgs } from '../config/index.js';
import { createStorage } from '../storage/index.js';
import { createCustomRuleStore } from '../custom-rule-store.js';
import { createCustomRule } from '../eval/rules/custom.js';
import { EvalEngine } from '../eval/engine.js';
import { evaluateStoredTrace, type IngestEvalType } from '../eval/ingest.js';
import { dormantRulesFrom } from '../eval/dormant.js';
import { ingestTraceSchema } from '../dashboard/validation.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import type { Trace } from '../types/trace.js';
import { generateSpanId, generateTraceId } from '../utils/ids.js';
import { COMMAND } from '../identity.js';
import { resolveCaseKey } from '../eval/case-key.js';

export const FAIL_ON = ['policy_gate', 'detector_veto', 'critical_unknown', 'required_evidence_missing', 'risk_over_loss', 'fail', 'unknown', 'any'] as const;
export type FailOn = (typeof FAIL_ON)[number];

export interface IngestOptions {
  cliArgs: CliArgs;
  /** A file of one JSON trace, or NDJSON (one trace per line). Absent: stdin. */
  file?: string;
  evaluate: boolean;
  evalType?: IngestEvalType;
  failOn?: FailOn;
  /** Overrides storage.redact for this ingest. */
  redact?: 'none' | 'critical_spans';
  source: 'cli' | 'hook';
  /** A dataset id or label: `--fail-on` then trips only on traces whose case key is in it (arc 8, R-8). */
  dataset?: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/** Whether a verdict trips `--fail-on`. */
export function trips(failOn: FailOn, verdict: { state: string; basis: string }): boolean {
  switch (failOn) {
    case 'any':
      return verdict.state !== 'pass';
    case 'fail':
      return verdict.state === 'fail';
    case 'unknown':
      return verdict.state === 'unknown';
    default:
      return verdict.basis === failOn;
  }
}

/*
 * One JSON trace, or NDJSON — one complete object per line. A line that is
 * a whole object while nothing is buffered is one trace; anything else is
 * buffered as a pretty-printed document and parsed at the end.
 *
 * Until 0.15.0 only the FIRST complete line was taken as a trace: a flag
 * flipped after it and every later line was buffered together, so an
 * NDJSON file of three or more traces died on the second with a JSON
 * syntax error — two traces happened to work because the lone second line
 * parsed as the "document". Found by the dataset gate's test (arc 8, R-8),
 * which was the first to pipe three.
 */
async function* readTraces(source: Readable): AsyncGenerator<unknown> {
  const rl = createInterface({ input: source, crlfDelay: Infinity });
  let buffered = '';
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (buffered === '' && trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        yield JSON.parse(trimmed);
        continue;
      } catch {
        /* fall through to buffering: a one-line prefix of a pretty-printed document */
      }
    }
    buffered += line + '\n';
  }
  if (buffered.trim() !== '') yield JSON.parse(buffered);
}

export async function runIngest(o: IngestOptions): Promise<number> {
  if (o.dataset !== undefined && !o.failOn) {
    o.stderr.write(`${COMMAND} ingest: --dataset restricts the gate, so it needs --fail-on <basis>.\nRun \`${COMMAND} --help\` for usage.\n`);
    return 2;
  }
  const config = loadConfig(o.cliArgs);
  if (o.redact) config.storage.redact = o.redact;
  const storage = createStorage(config);
  await storage.initialize();
  let stored = 0;
  let tripped = 0;
  let rejected = 0;
  let gateSummary: string | null = null;
  try {
    const customRuleStore = createCustomRuleStore();
    const engine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    for (const rule of customRuleStore.enabledRules(LOCAL_TENANT)) {
      engine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);
    }
    const dormant = () => dormantRulesFrom(customRuleStore.quarantined(LOCAL_TENANT));
    // The gate's cases (arc 8, R-8): read once; an unknown dataset is a usage error before any trace is read.
    let gate: { label: string; keys: Set<string> } | null = null;
    if (o.dataset !== undefined) {
      const found = await storage.getDataset(LOCAL_TENANT, o.dataset);
      if (!found) {
        o.stderr.write(`${COMMAND} ingest: no dataset has the id or label "${o.dataset}". List them at GET /api/v1/datasets, or create one with POST /api/v1/datasets from the case keys of a run.\n`);
        return 2;
      }
      gate = { label: found.label, keys: new Set(found.caseKeys.map((c) => c.caseKey)) };
    }
    let evaluated = 0;
    let inGate = 0;
    const input = o.file ? createReadStream(o.file, 'utf8') : o.stdin;

    for await (const raw of readTraces(input)) {
      const parsed = ingestTraceSchema.safeParse(raw);
      if (!parsed.success) {
        rejected++;
        const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
        o.stderr.write(`${COMMAND} ingest: rejected a trace — ${issues}\n`);
        continue;
      }
      const body = parsed.data;
      const traceId = generateTraceId();
      const trace: Trace & { output?: string } = {
        trace_id: traceId,
        agent_name: body.agent_name,
        framework: body.framework,
        input: body.input,
        output: body.output,
        tool_calls: body.tool_calls,
        latency_ms: body.latency_ms,
        token_usage: body.token_usage,
        cost_usd: body.cost_usd,
        metadata: body.metadata as Record<string, unknown> | undefined,
        timestamp: body.timestamp ?? new Date().toISOString(),
        tools: body.tools,
        run_id: body.run,
        case_key: body.case_key,
        source: o.source,
        spans: body.spans?.map((s) => ({ ...s, span_id: s.span_id ?? generateSpanId(), trace_id: traceId })),
      };
      const wantEvaluate = o.evaluate || body.evaluate === true;
      if (wantEvaluate && trace.output === undefined) {
        rejected++;
        o.stderr.write(`${COMMAND} ingest: rejected a trace — evaluate needs an output to score; nothing was stored for it\n`);
        continue;
      }
      await storage.insertTrace(LOCAL_TENANT, trace);
      stored++;
      if (!wantEvaluate) {
        o.stdout.write(JSON.stringify({ trace_id: traceId, status: 'stored' }) + '\n');
        continue;
      }
      const { result, response } = await evaluateStoredTrace(engine, storage, LOCAL_TENANT, trace as Trace & { output: string }, {
        evalType: o.evalType ?? body.eval_type,
        dormant: dormant(),
      });
      const verdict = result.verdict!;
      const coverage = (response as { coverage?: { questions?: Array<{ id: string; status: string }> } }).coverage;
      const unjudged = (coverage?.questions ?? []).filter((q) => q.status === 'unjudged').map((q) => q.id);
      const line: Record<string, unknown> = {
        trace_id: traceId,
        evaluation_id: result.id,
        passed: result.passed,
        verdict: { state: verdict.state, basis: verdict.basis, by: verdict.by },
        ...(unjudged.length > 0 ? { unjudged } : {}),
      };
      evaluated++;
      // Gated unless a dataset was named and this trace's case key is not in it.
      const caseKey = resolveCaseKey(trace.case_key, trace.input);
      const gated = gate === null || (caseKey !== null && gate.keys.has(caseKey));
      if (gate !== null) {
        line.gated = gated;
        if (gated) inGate++;
      }
      if (o.failOn && gated && trips(o.failOn, verdict)) {
        tripped++;
        line.tripped = o.failOn;
      }
      o.stdout.write(JSON.stringify(line) + '\n');
    }
    if (gate !== null) gateSummary = `${inGate} of ${evaluated} evaluated in dataset "${gate.label}"`;
  } finally {
    await storage.close();
  }
  if (rejected > 0 && stored === 0) {
    o.stderr.write(`${COMMAND} ingest: nothing stored (${rejected} rejected)\n`);
    return 2;
  }
  if (o.failOn) {
    const scope = gateSummary ? ` (${gateSummary})` : '';
    o.stderr.write(`${COMMAND} ingest: ${stored} stored, ${tripped} tripped --fail-on ${o.failOn}${scope}${rejected ? `, ${rejected} rejected` : ''}\n`);
    return tripped > 0 ? 1 : 0;
  }
  o.stderr.write(`${COMMAND} ingest: ${stored} stored${rejected ? `, ${rejected} rejected` : ''}\n`);
  return 0;
}

export const failOnSchema = z.enum(FAIL_ON);
