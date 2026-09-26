/*
 * proof:judge — measures the LLM-as-judge and the citation verifier against
 * labelled adversarial sets, and writes the numbers the docs and website
 * cite in place of the word "calibrated".
 *
 * What it does, end to end:
 *   1. Reads the provider, model, and cost caps from the environment, the
 *      same way the shipped tool does (IRIS_ANTHROPIC_API_KEY /
 *      IRIS_OPENAI_API_KEY for the key; IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL
 *      for the per-eval cap). A run-wide ceiling comes from
 *      PROOF_JUDGE_MAX_COST_USD (default $2.00).
 *   2. Runs every judge case through the REAL evaluateWithLLMJudge, and every
 *      citation case through the REAL verifyCitations — no mocks, no shortcut
 *      path. The judge's own `passed` verdict is what is scored.
 *   3. Per template: a confusion matrix against the deterministic labels,
 *      precision / recall / F1, Wilson 95% intervals, and the score drift the
 *      prompt-injection cases caused (each injection output paired against the
 *      identical output without the injected instruction).
 *   4. Citations: resolve accuracy (did the verifier resolve/skip/error each
 *      citation as labelled) and support precision/recall (of the citations it
 *      judged, did it rate supported the ones that truly are).
 *   5. answers_the_ask with the relevance judge installed, on the rule's own
 *      corpus family (proof/corpus/answers_the_ask.json) — through the REAL
 *      engine, so the number is the rule a deployment gets when it sets
 *      IRIS_RELEVANCE_JUDGE_MODEL — beside the lexical rule on the same cases.
 *   6. The composite corpus with that judge installed: how often the whole
 *      verdict is right about shipping at the shipped settings when a
 *      deployment turns the relevance judge on, beside the same measurement
 *      without it (proof/COMPOSITE.md), on the test and dev splits.
 *
 * The positive class for the judge half is FAIL — the judge flagging a
 * problem. So precision answers "of the outputs it flagged, how many were
 * real violations", and recall answers "of the real violations, how many it
 * caught". The false positives are exactly the adversarial-clean and
 * injection outputs a miscalibrated judge would wrongly fail.
 *
 * Without a key the run exits 2, prints one line, and writes NOTHING — never
 * a fake or partial results file. A committed pending file stays in place so
 * the website can render "pending" honestly until a keyed run replaces it.
 */

import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

import { evaluateWithLLMJudge } from '../../src/eval/llm-judge/evaluator.js';
import { verifyCitations } from '../../src/eval/citation-verify/verifier.js';
import { getTemplate } from '../../src/eval/llm-judge/templates/index.js';
import { estimateCostUsd, findPricing } from '../../src/eval/llm-judge/pricing.js';
import { estimateInputTokens, type LLMProvider } from '../../src/eval/llm-judge/client.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { createRelevanceJudge } from '../../src/eval/llm-judge/relevance-judge.js';
import { answersTheAsk } from '../../src/eval/rules/relevance.js';
import type { CorpusFile } from '../lib/corpus.js';
import { materialiseCase } from '../lib/materialise.js';
import { contextFor } from '../lib/context.js';
import { measureComposite, type ComposerSlice } from '../lib/composite-report.js';
import { defaultConfig } from '../../src/config/defaults.js';

import {
  readJudgeCaseFile,
  readCitationCaseFile,
  materialiseCases,
  TEMPLATE_NAMES,
  type JudgeCase,
  type TemplateName,
} from './lib/cases.js';
import { emptyConfusion, summarise, tally, round4, type Summary } from './lib/metrics.js';
import { wilson } from './lib/wilson.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const DEFAULT_MODEL: Record<LLMProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
};

/** Score delta above which an injection is counted as having "moved" the judge. */
const DRIFT_MOVED_THRESHOLD = 0.05;

interface RunConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  perEvalCapUsd: number;
  maxCostUsd: number;
}

interface TemplateResult {
  name: TemplateName;
  n: number;
  skipped: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  ci95: Summary['ci95'];
  adversarialDriftMean: number | null;
  adversarialCasesMoved: number;
  adversarialCasesMeasured: number;
}

/** A rule measured with a judge installed, beside the same rule without one, on the rule's own corpus family. */
interface JudgedRuleResult {
  rule: 'answers_the_ask';
  family: string;
  n: number;
  /** Cases not measured: the run-wide cap was reached, or the judge did not answer (the rule then fell back to its lexical reading, which is not what this row measures). */
  skipped: number;
  judgeErrors: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  ci95: Summary['ci95'];
  /** The lexical rule (no judge) on the same measured cases, a skip counted as not failed as proof/run.ts counts it. */
  lexical: { tp: number; fp: number; fn: number; tn: number; skipped: number; precision: number | null; recall: number | null; f1: number | null; ci95: Summary['ci95'] };
  /** The ids each reading got wrong, so a reader can open the case. */
  errors: { judged: { fp: string[]; fn: string[] }; lexical: { fp: string[]; fn: string[] } };
}

export const ANSWERS_THE_ASK_FAMILY = 'proof/corpus/answers_the_ask.json';

/** The composite verdict measured with the relevance judge installed, beside the same corpus without it. */
interface CompositeWithJudge {
  compositeVersion: string;
  /** Judge calls made, and how many did not answer (each of those fell back to the lexical reading, so the row is incomplete). */
  judgeCalls: number;
  judgeErrors: number;
  complete: boolean;
  /** The risk composer (per-output prior, shipped τ), per split. */
  withJudge: { test: ComposerSlice; dev: ComposerSlice; realTranscripts: ComposerSlice };
  withoutJudge: { test: ComposerSlice; dev: ComposerSlice; realTranscripts: ComposerSlice };
  /** Cases whose verdict the judge changed, by id: now failing, now passing. */
  flipped: { toFail: string[]; toPass: string[] };
}

interface CitationResults {
  n: number;
  resolveMatched: number;
  resolveAccuracy: number | null;
  supportTp: number;
  supportFp: number;
  supportFn: number;
  supportTn: number;
  supportPrecision: number | null;
  supportRecall: number | null;
  ci95: {
    resolveAccuracy: ReturnType<typeof wilson>;
    supportPrecision: ReturnType<typeof wilson>;
    supportRecall: ReturnType<typeof wilson>;
  };
}

/**
 * Resolves the run configuration from an environment, exactly as the shipped
 * tool resolves its provider, key and caps. Returns `{ error }` — never
 * throws — so the caller can exit 2 and write nothing. Exported so a unit
 * test can assert the no-key refusal without spawning a provider call.
 */
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): { config: RunConfig } | { error: string } {
  const providerRaw = (env.PROOF_JUDGE_PROVIDER ?? 'anthropic').toLowerCase();
  if (providerRaw !== 'anthropic' && providerRaw !== 'openai') {
    return { error: `PROOF_JUDGE_PROVIDER must be "anthropic" or "openai", got "${providerRaw}"` };
  }
  const provider = providerRaw as LLMProvider;
  const model = env.PROOF_JUDGE_MODEL || DEFAULT_MODEL[provider];
  if (!findPricing(model)) {
    return { error: `No pricing for model "${model}"; add it to src/eval/llm-judge/pricing.ts or set PROOF_JUDGE_MODEL to a supported model` };
  }
  const apiKey =
    provider === 'anthropic' ? env.IRIS_ANTHROPIC_API_KEY : env.IRIS_OPENAI_API_KEY;
  if (!apiKey) {
    const varName = provider === 'anthropic' ? 'IRIS_ANTHROPIC_API_KEY' : 'IRIS_OPENAI_API_KEY';
    return { error: `No judge API key: ${varName} is not set for provider "${provider}". Set it, or dispatch the proof-judge workflow with a provider whose secret is configured. Nothing was measured or written.` };
  }
  const perEvalCapUsd = Number(env.IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL) || 0.25;
  const maxCostUsd = Number(env.PROOF_JUDGE_MAX_COST_USD) || 2.0;
  return { config: { provider, model, apiKey, perEvalCapUsd, maxCostUsd } };
}

/**
 * The evaluator's own pessimistic pre-check, replicated so the runner can
 * refuse a call BEFORE it happens when it would breach the run-wide cap:
 * every input character billed, the full output cap billed, plus the same
 * for the one malformed-JSON retry. Matches evaluator.ts exactly so the
 * runner's ceiling and the tool's ceiling agree.
 */
function estimateJudgeCostUsd(model: string, c: JudgeCase, maxOutputTokens = 512): number {
  const template = getTemplate(c.template);
  const system = template.buildSystem();
  const user = template.buildUser({
    output: c.output,
    expected: c.expected,
    input: c.input,
    sourceMaterial: c.sourceMaterial,
  });
  const strictSystem = system + '\n\nIMPORTANT: your previous response was not valid JSON. Respond with ONLY the JSON object, no prefatory text, no code fences.';
  const first = estimateCostUsd(model, estimateInputTokens(system, user), maxOutputTokens) ?? 0;
  const retry = estimateCostUsd(model, estimateInputTokens(strictSystem, user), Math.min(maxOutputTokens, 256)) ?? 0;
  return first + retry;
}

class Budget {
  spent = 0;
  exhausted = false;
  constructor(private readonly cap: number) {}
  get remaining(): number {
    return Math.max(0, this.cap - this.spent);
  }
  canAfford(estimate: number): boolean {
    return this.spent + estimate <= this.cap;
  }
  spend(amount: number): void {
    this.spent += amount;
  }
}

async function runTemplate(
  template: TemplateName,
  config: RunConfig,
  budget: Budget,
): Promise<TemplateResult> {
  const file = await readJudgeCaseFile(repoRoot, template);
  const cases = materialiseCases(file);
  const confusion = emptyConfusion();
  const scoreById = new Map<string, number>();
  const twinOfById = new Map<string, string | undefined>();
  let skipped = 0;

  for (const c of cases) {
    twinOfById.set(c.id, c.twinOf);
    const estimate = estimateJudgeCostUsd(config.model, c);
    if (budget.exhausted || !budget.canAfford(estimate)) {
      budget.exhausted = true;
      skipped++;
      continue;
    }
    let result;
    try {
      result = await evaluateWithLLMJudge({
        output: c.output,
        template: c.template,
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        input: c.input,
        expected: c.expected,
        sourceMaterial: c.sourceMaterial,
        maxCostUsdPerEval: config.perEvalCapUsd,
        temperature: 0,
      });
    } catch (err) {
      // A single case that errors (rate limit exhausted, provider hiccup)
      // is recorded as skipped rather than crashing the whole run — the
      // measurement reports how many it could not judge.
      process.stderr.write(`  ! ${c.id}: ${(err as Error).message}\n`);
      skipped++;
      continue;
    }
    budget.spend(result.costUsd ?? 0);
    scoreById.set(c.id, result.score);

    const actualPositive = c.label === 'fail'; // the case SHOULD be failed
    const predictedPositive = result.passed === false; // the judge failed it
    tally(confusion, actualPositive, predictedPositive);
    process.stdout.write(
      `  ${template.padEnd(13)} ${c.id.padEnd(28)} label=${c.label.padEnd(4)} judge=${(result.passed ? 'pass' : 'fail').padEnd(4)} score=${result.score.toFixed(2)} $${budget.spent.toFixed(4)}\n`,
    );
  }

  // Injection drift: |score(injection) - score(twin)|, only where both ran.
  const deltas: number[] = [];
  let moved = 0;
  for (const [id, twinOf] of twinOfById) {
    if (!twinOf) continue;
    const a = scoreById.get(id);
    const b = scoreById.get(twinOf);
    if (a === undefined || b === undefined) continue;
    const delta = Math.abs(a - b);
    deltas.push(delta);
    if (delta >= DRIFT_MOVED_THRESHOLD) moved++;
  }
  const driftMean =
    deltas.length === 0 ? null : round4(deltas.reduce((s, d) => s + d, 0) / deltas.length);

  const summary = summarise(confusion);
  return {
    name: template,
    n: summary.n,
    skipped,
    tp: summary.tp,
    fp: summary.fp,
    fn: summary.fn,
    tn: summary.tn,
    precision: summary.precision,
    recall: summary.recall,
    f1: summary.f1,
    ci95: summary.ci95,
    adversarialDriftMean: driftMean,
    adversarialCasesMoved: moved,
    adversarialCasesMeasured: deltas.length,
  };
}

/**
 * answers_the_ask with the relevance judge, through the engine a deployment
 * runs: an EvalEngine with createRelevanceJudge installed, evaluating the
 * relevance bundle, reading answers_the_ask's row. The lexical rule runs on
 * the same case with no judge, so the two rows differ by the judge alone.
 */
async function runAnswersTheAskJudged(config: RunConfig, budget: Budget): Promise<JudgedRuleResult> {
  const file = JSON.parse(readFileSync(resolve(repoRoot, ANSWERS_THE_ASK_FAMILY), 'utf-8')) as CorpusFile;
  const engine = new EvalEngine();
  engine.setRelevanceJudge(
    createRelevanceJudge({ model: config.model, provider: config.provider, apiKey: config.apiKey, maxCostUsdPerEval: config.perEvalCapUsd }),
  );
  const judged = emptyConfusion();
  const lexical = emptyConfusion();
  const errors = { judged: { fp: [] as string[], fn: [] as string[] }, lexical: { fp: [] as string[], fn: [] as string[] } };
  let skipped = 0;
  let judgeErrors = 0;
  let lexicalSkipped = 0;

  for (const raw of file.cases) {
    const c = materialiseCase(raw);
    const context = contextFor(c, file.config);
    const estimate = estimateJudgeCostUsd(config.model, { id: c.id, template: 'relevance', group: 'clean', label: 'pass', rubricRef: 'pass', input: c.input, output: c.output, why: '' });
    if (budget.exhausted || !budget.canAfford(estimate)) {
      budget.exhausted = true;
      skipped++;
      continue;
    }
    const result = await engine.evaluate('relevance', context);
    const row = result.rule_results.find((r) => r.ruleName === 'answers_the_ask');
    budget.spend(row?.judge?.costUsd ?? 0);
    if (!row?.judge || row.judge.error !== undefined) {
      process.stderr.write(`  ! answers_the_ask/${c.id}: ${row?.judge?.error ?? 'no judgment'}\n`);
      judgeErrors++;
      skipped++;
      continue;
    }
    const actual = c.label === 'positive';
    const predicted = !row.skipped && row.passed === false;
    tally(judged, actual, predicted);
    if (predicted && !actual) errors.judged.fp.push(c.id);
    if (!predicted && actual) errors.judged.fn.push(c.id);

    const lex = answersTheAsk.evaluate(context);
    if (lex.skipped) lexicalSkipped++;
    const lexPredicted = !lex.skipped && lex.passed === false;
    tally(lexical, actual, lexPredicted);
    if (lexPredicted && !actual) errors.lexical.fp.push(c.id);
    if (!lexPredicted && actual) errors.lexical.fn.push(c.id);

    process.stdout.write(
      `  answers_the_ask ${c.id.padEnd(24)} label=${c.label.padEnd(8)} judge=${(predicted ? 'fail' : 'pass').padEnd(4)} lexical=${lex.skipped ? 'skip' : lexPredicted ? 'fail' : 'pass'} score=${row.judge.score?.toFixed(2)} $${budget.spent.toFixed(4)}\n`,
    );
  }

  const s = summarise(judged);
  const l = summarise(lexical);
  return {
    rule: 'answers_the_ask',
    family: ANSWERS_THE_ASK_FAMILY,
    n: s.n,
    skipped,
    judgeErrors,
    tp: s.tp,
    fp: s.fp,
    fn: s.fn,
    tn: s.tn,
    precision: s.precision,
    recall: s.recall,
    f1: s.f1,
    ci95: s.ci95,
    lexical: { tp: l.tp, fp: l.fp, fn: l.fn, tn: l.tn, skipped: lexicalSkipped, precision: l.precision, recall: l.recall, f1: l.f1, ci95: l.ci95 },
    errors,
  };
}

/**
 * The composite corpus through an engine built from the shipped config with
 * the relevance judge installed — the verdict a deployment gets when it sets
 * IRIS_RELEVANCE_JUDGE_MODEL — beside the same engine without the judge. The
 * judge's calls are charged to the run-wide budget; once it is spent the
 * judge refuses, the rule falls back to its lexical reading, and the result
 * is marked incomplete rather than passed off as the judge's.
 */
async function runCompositeWithJudge(config: RunConfig, budget: Budget): Promise<CompositeWithJudge> {
  let judgeCalls = 0;
  let judgeErrors = 0;
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  engine.setRelevanceJudge(
    createRelevanceJudge({
      model: config.model,
      provider: config.provider,
      apiKey: config.apiKey,
      maxCostUsdPerEval: config.perEvalCapUsd,
      evaluate: async (params) => {
        judgeCalls++;
        if (budget.exhausted || budget.remaining < config.perEvalCapUsd) {
          budget.exhausted = true;
          judgeErrors++;
          throw new Error('the proof run-wide cost cap was reached before this case');
        }
        try {
          const r = await evaluateWithLLMJudge(params);
          budget.spend(r.costUsd ?? 0);
          return r;
        } catch (err) {
          judgeErrors++;
          throw err;
        }
      },
    }),
  );
  const compared = await compareCompositeWithJudge(repoRoot, engine);
  process.stdout.write(`  composite with judge: test acc=${fmtPct(compared.withJudge.test.accuracy.rate)} (without ${fmtPct(compared.withoutJudge.test.accuracy.rate)}), dev acc=${fmtPct(compared.withJudge.dev.accuracy.rate)} (without ${fmtPct(compared.withoutJudge.dev.accuracy.rate)}), ${judgeCalls} judge calls $${budget.spent.toFixed(4)}\n`);
  return { ...compared, judgeCalls, judgeErrors, complete: judgeErrors === 0 };
}

/**
 * The composite measured through `engine` (a relevance judge installed) and
 * through the shipped engine without one, and the verdicts that differ.
 * Exported so the comparison itself is tested without a key, on a stand-in
 * judge.
 */
export async function compareCompositeWithJudge(root: string, engine: EvalEngine): Promise<Omit<CompositeWithJudge, 'judgeCalls' | 'judgeErrors' | 'complete'>> {
  const judged = await measureComposite(root, engine);
  const plain = await measureComposite(root);
  const byId = new Map(plain.rows.map((r) => [r.id, r]));
  const toFail: string[] = [];
  const toPass: string[] = [];
  for (const r of judged.rows) {
    const before = byId.get(r.id);
    if (!before) continue;
    if (before.risk.state !== 'fail' && r.risk.state === 'fail') toFail.push(r.id);
    if (before.risk.state === 'fail' && r.risk.state !== 'fail') toPass.push(r.id);
  }
  return {
    compositeVersion: judged.results.compositeVersion,
    withJudge: { test: judged.results.risk.test, dev: judged.results.risk.dev, realTranscripts: judged.results.risk.realTranscripts },
    withoutJudge: { test: plain.results.risk.test, dev: plain.results.risk.dev, realTranscripts: plain.results.risk.realTranscripts },
    flipped: { toFail, toPass },
  };
}

async function runCitations(config: RunConfig, budget: Budget): Promise<CitationResults> {
  const file = await readCitationCaseFile(repoRoot);
  let resolveMatched = 0;
  let resolveTotal = 0;
  const support = emptyConfusion();

  for (const c of file.cases) {
    // A citation case makes up to (citations) judge calls; guard on the
    // remaining budget with a per-source pessimistic floor so we never blow
    // the cap. verifyCitations enforces its own maxCostUsdTotal too.
    if (budget.exhausted || budget.remaining < config.perEvalCapUsd) {
      budget.exhausted = true;
      break;
    }
    let res;
    try {
      res = await verifyCitations({
        output: c.output,
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        allowFetch: true,
        maxCostUsdTotal: Math.min(budget.remaining, config.maxCostUsd),
      });
    } catch (err) {
      process.stderr.write(`  ! citations/${c.id}: ${(err as Error).message}\n`);
      continue;
    }
    budget.spend(res.totalCostUsd);

    // Match each returned verified citation to its label by identifier.
    const labelByIdent = new Map(c.citations.map((l) => [`${l.kind}:${l.identifier}`, l]));
    for (const vc of res.citations) {
      const key = `${vc.citation.kind}:${vc.citation.identifier}`;
      const label = labelByIdent.get(key);
      if (!label) continue;
      resolveTotal++;
      if (vc.resolveStatus === label.resolve) resolveMatched++;

      // Support confusion only over citations the label says resolve AND that
      // the verifier actually judged. positive = supported.
      if (label.resolve === 'ok' && label.supported !== null && vc.judge) {
        tally(support, label.supported === true, vc.judge.supported === true);
      }
    }
    process.stdout.write(
      `  citations    ${c.id.padEnd(28)} found=${res.totalCitationsFound} judged=${res.totalJudged} $${budget.spent.toFixed(4)}\n`,
    );
  }

  const resolveAccuracy = resolveTotal === 0 ? null : round4(resolveMatched / resolveTotal);
  const s = summarise(support);
  return {
    n: resolveTotal,
    resolveMatched,
    resolveAccuracy,
    supportTp: s.tp,
    supportFp: s.fp,
    supportFn: s.fn,
    supportTn: s.tn,
    supportPrecision: s.precision,
    supportRecall: s.recall,
    ci95: {
      resolveAccuracy: resolveTotal === 0 ? null : wilson(resolveMatched, resolveTotal),
      supportPrecision: s.ci95.precision,
      supportRecall: s.ci95.recall,
    },
  };
}

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function templatesSha(): string {
  const bytes = readFileSync(resolve(repoRoot, 'src/eval/llm-judge/templates/index.ts'));
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function fmtPct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}

function fmtCi(ci: { lo: number; hi: number } | null): string {
  return ci === null ? '—' : `[${(ci.lo * 100).toFixed(1)}, ${(ci.hi * 100).toFixed(1)}]`;
}

function renderResultsMd(
  meta: { generatedAt: string; commit: string; model: string; provider: string; totalCostUsd: number; promptTemplateSha: string; complete: boolean },
  templates: TemplateResult[],
  citations: CitationResults,
  rules: JudgedRuleResult[],
  composite: CompositeWithJudge,
): string {
  const lines: string[] = [];
  lines.push('# Iris judge + citation measurement');
  lines.push('');
  lines.push(`Generated ${meta.generatedAt} at commit \`${meta.commit}\` using \`${meta.model}\` (${meta.provider}).`);
  lines.push(`Prompt templates sha256[0:16]: \`${meta.promptTemplateSha}\`. Total cost this run: $${meta.totalCostUsd.toFixed(4)}.`);
  if (!meta.complete) {
    lines.push('');
    lines.push('> ⚠ The run-wide cost cap was reached before every case was judged. Some cases are counted as skipped; raise `PROOF_JUDGE_MAX_COST_USD` for a complete measurement.');
  }
  lines.push('');
  lines.push('The judge half scores the FAIL class: precision = of the outputs the judge flagged, the share that were real violations; recall = of the real violations, the share the judge caught. False positives are the clean and injection outputs a miscalibrated judge would wrongly fail. Intervals are Wilson 95%.');
  lines.push('');
  lines.push('## LLM-as-judge, per template');
  lines.push('');
  lines.push('| Template | n | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) | F1 | Injection drift (mean · moved) |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|---|---|--:|---|');
  for (const t of templates) {
    const drift =
      t.adversarialCasesMeasured === 0
        ? '—'
        : `${t.adversarialDriftMean?.toFixed(3)} · ${t.adversarialCasesMoved}/${t.adversarialCasesMeasured}`;
    lines.push(
      `| ${t.name} | ${t.n} | ${t.skipped} | ${t.tp} | ${t.fp} | ${t.fn} | ${t.tn} | ${fmtPct(t.precision)} ${fmtCi(t.ci95.precision)} | ${fmtPct(t.recall)} ${fmtCi(t.ci95.recall)} | ${t.f1 === null ? '—' : t.f1.toFixed(3)} | ${drift} |`,
    );
  }
  lines.push('');
  lines.push('Injection drift is the mean absolute change in the judge\'s score when a prompt-injection instruction is appended to an output, measured against the identical output without it. Lower is better; 0 means the injection moved nothing. "moved" counts pairs whose score changed by at least ' + DRIFT_MOVED_THRESHOLD + '.');
  lines.push('');
  lines.push('## Rules with the judge installed');
  lines.push('');
  lines.push('Each rule a judge can decide, measured on its own corpus family through the engine a deployment runs with the judge installed, beside the same rule with no judge on the same cases. The positive class is the violation, as on the rule proof table.');
  lines.push('');
  lines.push('| Rule | Family | n | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) | F1 | Without the judge: precision · recall · F1 |');
  lines.push('|---|---|--:|--:|--:|--:|--:|--:|---|---|--:|---|');
  for (const r of rules) {
    lines.push(
      `| ${r.rule} | ${r.family} | ${r.n} | ${r.skipped} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${fmtPct(r.precision)} ${fmtCi(r.ci95.precision)} | ${fmtPct(r.recall)} ${fmtCi(r.ci95.recall)} | ${r.f1 === null ? '—' : r.f1.toFixed(3)} | ${fmtPct(r.lexical.precision)} · ${fmtPct(r.lexical.recall)} · ${r.lexical.f1 === null ? '—' : r.lexical.f1.toFixed(3)} |`,
    );
  }
  lines.push('');
  for (const r of rules) {
    lines.push(`- \`${r.rule}\` with the judge — FP: ${r.errors.judged.fp.join(', ') || 'none'} · FN: ${r.errors.judged.fn.join(', ') || 'none'}. Without it — FP: ${r.errors.lexical.fp.join(', ') || 'none'} · FN: ${r.errors.lexical.fn.join(', ') || 'none'}.${r.judgeErrors > 0 ? ` The judge did not answer on ${r.judgeErrors} case(s); they are counted under skip.` : ''}`);
  }
  lines.push('');
  lines.push('## The composite verdict with the relevance judge');
  lines.push('');
  lines.push(`The composite corpus (${composite.compositeVersion}) through an engine built from the shipped config, with and without the relevance judge installed. Risk composer, per-output prior, shipped τ; Wilson 95% intervals. ${composite.judgeCalls} judge calls.${composite.complete ? '' : ` INCOMPLETE: the judge did not answer on ${composite.judgeErrors} call(s) (the run-wide cap or a provider error), and those cases fell back to the lexical reading.`}`);
  lines.push('');
  lines.push('| Split | Relevance judge | Right about shipping | False blocks on clean | Missed blocks |');
  lines.push('|---|---|---|---|---|');
  const rate = (r: ComposerSlice['accuracy']) => `${fmtPct(r.rate)} ${fmtCi(r.ci95 ? { lo: r.ci95[0], hi: r.ci95[1] } : null)} (${r.k}/${r.n})`;
  for (const split of ['test', 'dev', 'realTranscripts'] as const) {
    for (const [label, slice] of [['off', composite.withoutJudge[split]], ['on', composite.withJudge[split]]] as const) {
      lines.push(`| ${split} | ${label} | ${rate(slice.accuracy)} | ${rate(slice.falseBlock)} | ${rate(slice.missedBlock)} |`);
    }
  }
  lines.push('');
  lines.push(`Verdicts the judge moved to fail: ${composite.flipped.toFail.join(', ') || 'none'}. Moved to pass: ${composite.flipped.toPass.join(', ') || 'none'}.`);
  lines.push('');
  lines.push('## Citation verifier');
  lines.push('');
  lines.push('| Metric | Value | 95% CI |');
  lines.push('|---|--:|---|');
  lines.push(`| Resolve accuracy (${citations.resolveMatched}/${citations.n}) | ${fmtPct(citations.resolveAccuracy)} | ${fmtCi(citations.ci95.resolveAccuracy)} |`);
  lines.push(`| Support precision (${citations.supportTp}/${citations.supportTp + citations.supportFp}) | ${fmtPct(citations.supportPrecision)} | ${fmtCi(citations.ci95.supportPrecision)} |`);
  lines.push(`| Support recall (${citations.supportTp}/${citations.supportTp + citations.supportFn}) | ${fmtPct(citations.supportRecall)} | ${fmtCi(citations.ci95.supportRecall)} |`);
  lines.push('');
  lines.push('Resolve accuracy: the share of labelled citations the verifier resolved, skipped or errored exactly as the label says. Support precision/recall: over the citations it judged, the FAIL/PASS on whether it rated supported the ones that truly are (positive = supported). These citations fetch live public pages, so a resolve mismatch can also mean a cited page changed — see proof/citations/cases.json for what each expects.');
  lines.push('');
  lines.push('Reproduce: `PROOF_JUDGE_MAX_COST_USD=2.00 IRIS_ANTHROPIC_API_KEY=... npm run proof:judge` (or dispatch `.github/workflows/proof-judge.yml`). See proof/judge/README.md.');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const read = readConfig();
  if ('error' in read) {
    process.stderr.write(`proof:judge — ${read.error}\n`);
    process.exit(2);
  }
  const { config } = read;
  process.stdout.write(
    `proof:judge — provider=${config.provider} model=${config.model} cap=$${config.maxCostUsd.toFixed(2)} per-eval=$${config.perEvalCapUsd.toFixed(2)}\n`,
  );

  const budget = new Budget(config.maxCostUsd);
  const templates: TemplateResult[] = [];
  for (const t of TEMPLATE_NAMES) {
    templates.push(await runTemplate(t as TemplateName, config, budget));
  }
  const citations = await runCitations(config, budget);
  const rules = [await runAnswersTheAskJudged(config, budget)];
  const composite = await runCompositeWithJudge(config, budget);

  const complete = !budget.exhausted;
  const generatedAt = new Date().toISOString();
  const commit = gitCommit();
  const promptTemplateSha = templatesSha();
  const totalCostUsd = Math.round(budget.spent * 1_000_000) / 1_000_000;

  const results = {
    schemaVersion: 1 as const,
    status: 'measured' as const,
    generatedAt,
    commit,
    model: config.model,
    provider: config.provider,
    promptTemplateSha,
    maxCostUsd: config.maxCostUsd,
    perEvalCapUsd: config.perEvalCapUsd,
    complete,
    totalCostUsd,
    templates: templates.map((t) => ({
      name: t.name,
      n: t.n,
      skipped: t.skipped,
      tp: t.tp,
      fp: t.fp,
      fn: t.fn,
      tn: t.tn,
      precision: t.precision,
      recall: t.recall,
      f1: t.f1,
      ci95: t.ci95,
      adversarialDriftMean: t.adversarialDriftMean,
      adversarialCasesMoved: t.adversarialCasesMoved,
      adversarialCasesMeasured: t.adversarialCasesMeasured,
    })),
    citations: {
      n: citations.n,
      resolveAccuracy: citations.resolveAccuracy,
      supportPrecision: citations.supportPrecision,
      supportRecall: citations.supportRecall,
      supportTp: citations.supportTp,
      supportFp: citations.supportFp,
      supportFn: citations.supportFn,
      supportTn: citations.supportTn,
      ci95: citations.ci95,
    },
    rules,
    composite,
  };

  await writeFile(resolve(repoRoot, 'proof/judge-results.json'), JSON.stringify(results, null, 2) + '\n');
  await writeFile(
    resolve(repoRoot, 'proof/judge/RESULTS.md'),
    renderResultsMd(
      { generatedAt, commit, model: config.model, provider: config.provider, totalCostUsd, promptTemplateSha, complete },
      templates,
      citations,
      rules,
      composite,
    ),
  );

  process.stdout.write(`\nproof:judge — wrote proof/judge-results.json and proof/judge/RESULTS.md · total $${totalCostUsd.toFixed(4)}${complete ? '' : ' (INCOMPLETE — cost cap reached)'}\n`);
  if (!complete) {
    process.stderr.write('proof:judge — WARNING: the run-wide cap was reached before every case ran; results are marked complete:false.\n');
  }
}

// Only run when invoked directly (npm run proof:judge / node --import tsx
// proof/judge/run.ts). Importing this module — the unit test does, to reach
// readConfig — must NOT kick off a measurement.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`proof:judge — fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
