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
import { createReadStream, statSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { loadConfig, type CliArgs } from '../config/index.js';
import { createStorage } from '../storage/index.js';
import { announceUpgrade } from './upgrade-notice.js';
import { createCustomRuleStore } from '../custom-rule-store.js';
import { createCustomRule } from '../eval/rules/custom.js';
import { EvalEngine } from '../eval/engine.js';
import { relevanceJudgeFromEnv, relevanceJudgeStartupWarnings } from '../eval/llm-judge/relevance-judge.js';
import { evaluateStoredTrace, type IngestEvalType } from '../eval/ingest.js';
import { dormantRulesFrom } from '../eval/dormant.js';
import { ingestTraceSchema } from '../dashboard/validation.js';
import { LOCAL_TENANT } from '../types/tenant.js';
import type { Trace } from '../types/trace.js';
import { generateSpanId, generateTraceId } from '../utils/ids.js';
import { COMMAND } from '../identity.js';
import { resolveCaseKey } from '../eval/case-key.js';
import { registerPlugins } from '../eval/plugins.js';
import { costFieldsOf, resolveTraceCost } from '../cost/trace-cost.js';
import { canonicalCapture } from '../eval/evidence.js';

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
  /** A dataset id or label: `--fail-on` then trips only on traces whose case key is in it. */
  dataset?: string;
  /** With `failOn`: a gate with no trace in it exits 0 instead of 2. */
  allowEmpty?: boolean;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/** The span evidence the tripping rules stamped: rule, label, source and offsets into the raw text — never the text itself. */
export function spansOf(
  ruleResults: ReadonlyArray<{ ruleName: string; evidence?: ReadonlyArray<Record<string, unknown>> }>,
  by: ReadonlyArray<string>,
): Array<{ rule: string; label: string; source: string; start: number; end: number }> {
  const out: Array<{ rule: string; label: string; source: string; start: number; end: number }> = [];
  for (const r of ruleResults) {
    if (!by.includes(r.ruleName)) continue;
    for (const e of r.evidence ?? []) {
      if (e.type === 'span' && typeof e.start === 'number' && typeof e.end === 'number') {
        out.push({ rule: r.ruleName, label: String(e.label ?? ''), source: String(e.source ?? 'output'), start: e.start, end: e.end });
      }
    }
  }
  return out;
}

interface Layer {
  state: string;
  basis: string;
  by?: ReadonlyArray<string>;
}

/**
 * The layers of a verdict that answer `--fail-on`: the one that decided and
 * every later one that would have (`verdict.also`).
 *
 * `basis` names one layer (the first that fails, else the first that could
 * not check). Reading it alone
 * let an output that broke a configured policy AND leaked a credential pass
 * `--fail-on detector_veto` with exit 0, because `policy_gate` is asked
 * first.
 */
export function trippedLayers(failOn: FailOn, verdict: Layer & { also?: ReadonlyArray<Layer> }): Layer[] {
  if (verdict.state === 'pass') return [];
  const layers: Layer[] = [verdict, ...(verdict.also ?? [])];
  switch (failOn) {
    case 'any':
      return layers;
    case 'fail':
    case 'unknown':
      return layers.filter((l) => l.state === failOn);
    default:
      return layers.filter((l) => l.basis === failOn);
  }
}

/** Whether a verdict trips `--fail-on`. */
export function trips(failOn: FailOn, verdict: Layer & { also?: ReadonlyArray<Layer> }): boolean {
  return trippedLayers(failOn, verdict).length > 0;
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
 * parsed as the "document". Found by the dataset gate's test,
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
  if (o.allowEmpty && !o.failOn) {
    o.stderr.write(`${COMMAND} ingest: --allow-empty is about the gate, so it needs --fail-on <basis>.\nRun \`${COMMAND} --help\` for usage.\n`);
    return 2;
  }
  // Before the database is opened: a path that is not a file used to surface as a stack trace with exit 1, the code a tripped gate uses.
  if (o.file !== undefined && !isFile(o.file)) {
    o.stderr.write(`${COMMAND} ingest: --file ${o.file} is not a file. Nothing was read.\n`);
    return 2;
  }
  const config = loadConfig(o.cliArgs);
  if (o.redact) config.storage.redact = o.redact;
  const storage = createStorage(config);
  await storage.initialize();
  announceUpgrade(storage.upgradeReport?.(), { write: (line) => o.stderr.write(line) });
  let stored = 0;
  let tripped = 0;
  let rejected = 0;
  let gateSummary: string | null = null;
  let evaluated = 0;
  let inGate = 0;
  let gateLabel: string | null = null;
  try {
    const customRuleStore = createCustomRuleStore();
    const engine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    /*
     * The relevance judge, when the deployment named one: the same engine the
     * server boots, so a trace scores the same through every door, drawing on
     * the same daily budget in the same database. An ingest is not one
     * request: each trace it reads is its own, and the daily budget is what
     * bounds a large file.
     */
    engine.setRelevanceJudge(relevanceJudgeFromEnv({ ledger: storage.judgeSpendLedger(), log: (line) => o.stderr.write(`${line}\n`) }));
    for (const line of relevanceJudgeStartupWarnings(engine.relevanceJudgeInForce())) o.stderr.write(`${line}\n`);
    for (const rule of customRuleStore.enabledRules(LOCAL_TENANT)) {
      engine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);
    }
    // Plugin rules: the same loader the server boots with; a
    // file Iris cannot verify is a usage error before any trace is read.
    try {
      await registerPlugins(engine, config);
    } catch (err) {
      o.stderr.write(`${COMMAND} ingest: ${err instanceof Error ? err.message : String(err)}
`);
      return 2;
    }
    const dormant = () => dormantRulesFrom(customRuleStore.quarantined(LOCAL_TENANT));
    // The gate's cases: read once; an unknown dataset is a usage error before any trace is read.
    let gate: { label: string; keys: Set<string> } | null = null;
    if (o.dataset !== undefined) {
      const found = await storage.getDataset(LOCAL_TENANT, o.dataset);
      if (!found) {
        o.stderr.write(`${COMMAND} ingest: no dataset has the id or label "${o.dataset}". List them at GET /api/v1/datasets, or create one with POST /api/v1/datasets from the case keys of a run.\n`);
        return 2;
      }
      gate = { label: found.label, keys: new Set(found.caseKeys.map((c) => c.caseKey)) };
    }
    gateLabel = gate?.label ?? null;
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
      // Settled before it is stored or scored, as on every other door (src/cost/trace-cost.ts).
      const trace: Trace & { output?: string } = resolveTraceCost({
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
        ...(body.capture ? { capture: canonicalCapture(body.capture) } : {}),
        spans: body.spans?.map((s) => ({ ...s, span_id: s.span_id ?? generateSpanId(), trace_id: traceId })),
      });
      const wantEvaluate = o.evaluate || body.evaluate === true;
      if (wantEvaluate && trace.output === undefined) {
        rejected++;
        o.stderr.write(`${COMMAND} ingest: rejected a trace — evaluate needs an output to score; nothing was stored for it\n`);
        continue;
      }
      await storage.insertTrace(LOCAL_TENANT, trace);
      stored++;
      if (!wantEvaluate) {
        o.stdout.write(JSON.stringify({ trace_id: traceId, status: 'stored', ...costFieldsOf(trace) }) + '\n');
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
        verdict: { state: verdict.state, basis: verdict.basis, by: verdict.by, ...(verdict.also ? { also: verdict.also } : {}) },
        ...(unjudged.length > 0 ? { unjudged } : {}),
        ...costFieldsOf(trace),
      };
      evaluated++;
      // Gated unless a dataset was named and this trace's case key is not in it.
      const caseKey = resolveCaseKey(trace.case_key, trace.input);
      const gated = gate === null || (caseKey !== null && gate.keys.has(caseKey));
      if (gate !== null) {
        line.gated = gated;
        if (gated) inGate++;
      }
      const layers = o.failOn && gated ? trippedLayers(o.failOn, verdict) : [];
      if (layers.length > 0) {
        tripped++;
        line.tripped = o.failOn;
        // The span of what tripped: offsets and the label, never the text —
        // the org reader's job log can say WHERE the leaked credential sits without carrying it.
        const spans = spansOf(result.rule_results, layers.flatMap((l) => l.by ?? []));
        if (spans.length > 0) line.spans = spans;
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
    if (tripped > 0) return 1;
    /*
     * Exit 0 from a gate says "every trace was judged and none matched", so
     * it is refused whenever that is not what happened. Each of these used
     * to exit 0: a trace rejected for a malformed field or a missing output
     * (the run that crashed before answering), a trace stored without being
     * evaluated, an empty file, and a run with none of the dataset's cases.
     */
    const refuse = (why: string): number => {
      o.stderr.write(`${COMMAND} ingest: ${why}\n`);
      return 2;
    };
    if (rejected > 0) return refuse(`${rejected} trace${rejected === 1 ? ' was' : 's were'} rejected and never judged, so --fail-on ${o.failOn} cannot pass. Fix the trace${rejected === 1 ? '' : 's'} named above, or leave ${rejected === 1 ? 'it' : 'them'} out.`);
    if (evaluated < stored) return refuse(`${stored - evaluated} of ${stored} trace${stored === 1 ? '' : 's'} ${stored - evaluated === 1 ? 'was' : 'were'} stored without being evaluated, so --fail-on ${o.failOn} cannot pass. Pass --evaluate, or send "evaluate": true on each trace.`);
    const judged = gateLabel === null ? evaluated : inGate;
    if (judged === 0 && !o.allowEmpty) {
      return refuse(
        gateLabel === null
          ? `no trace was read from ${o.file ?? 'stdin'}, so --fail-on ${o.failOn} judged nothing and cannot pass. Pass --allow-empty if an empty run is expected.`
          : `none of the ${evaluated} evaluated trace${evaluated === 1 ? ' is' : 's are'} in dataset "${gateLabel}", so --fail-on ${o.failOn} judged nothing and cannot pass. Pass --allow-empty if a run with none of its cases is expected.`,
      );
    }
    return 0;
  }
  o.stderr.write(`${COMMAND} ingest: ${stored} stored${rejected ? `, ${rejected} rejected` : ''}\n`);
  return 0;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const failOnSchema = z.enum(FAIL_ON);
