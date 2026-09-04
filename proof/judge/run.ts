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
  };

  await writeFile(resolve(repoRoot, 'proof/judge-results.json'), JSON.stringify(results, null, 2) + '\n');
  await writeFile(
    resolve(repoRoot, 'proof/judge/RESULTS.md'),
    renderResultsMd(
      { generatedAt, commit, model: config.model, provider: config.provider, totalCostUsd, promptTemplateSha, complete },
      templates,
      citations,
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
