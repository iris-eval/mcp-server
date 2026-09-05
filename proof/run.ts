/*
 * npm run proof — measures every built-in rule on its labelled family and
 * writes the numbers the README, docs and website cite in place of
 * "measured against a labeled corpus".
 *
 * What it does:
 *   1. Loads every proof/corpus/<rule>.json, validates it, and hashes the
 *      set (corpusVersion) so a result can be tied to exactly the cases
 *      that produced it.
 *   2. For each family, calls the REAL rule's evaluate — imported from the
 *      registry in src/eval/rules/index.ts, the same object the engine
 *      runs — on each case with the context the case declares (input,
 *      expected, costUsd, tokenUsage, customConfig …). Placeholders are
 *      materialised deterministically from the case id first.
 *   3. Per rule: confusion matrix, precision, recall, F1, Wilson 95%
 *      intervals for precision and recall, and a seeded bootstrap interval
 *      for F1. A skipped result (the rule declined to judge: missing
 *      context, output too brief) is a non-prediction and is counted as
 *      "did not fail" — the reader sees the skip count beside the row.
 *   4. Writes proof/results.json (sorted keys, LF, 4 decimal places) and
 *      proof/RESULTS.md.
 *
 * `--check` regenerates both to a temporary directory and exits 1 if
 * either differs from the committed file (generation time and commit hash
 * excluded), so CI proves the committed numbers are the ones this code
 * produces. No network, no LLM, no key, no randomness beyond the fixed
 * bootstrap seed.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

import { rulesByType } from '../src/eval/rules/index.js';
import type { EvalContext, EvalRule, EvalType } from '../src/types/eval.js';
import { loadCorpus, validateCorpusFile, type CorpusFile } from './lib/corpus.js';
import { materialiseCase } from './lib/materialise.js';
import { summarise, F1_CI_METHOD, type Observation, type RuleSummary } from './lib/metrics.js';
import { measureComposite, renderCompositeMarkdown, normaliseCompositeForCheck, COMPOSITE_RESULTS_JSON, COMPOSITE_MD, type CompositeResults } from './lib/composite-report.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');

export const RESULTS_JSON = 'proof/results.json';
export const RESULTS_MD = 'proof/RESULTS.md';
/*
 * The third output (0.9.0): the same per-rule numbers as a generated
 * TypeScript module the SHIPPED server imports (src/eval/accuracy.ts), so a
 * verdict can carry the published precision and recall of each rule that
 * spoke. It has to be a compiled module under src/: the npm package ships
 * dist/ only, and a runtime read of proof/results.json finds nothing in an
 * installed copy. It carries the corpus version and the release, never a
 * commit hash or a timestamp, so `--check` compares it byte for byte.
 */
export const PUBLISHED_ACCURACY_TS = 'src/eval/published-accuracy.ts';

export interface RuleRow extends RuleSummary {
  name: string;
  category: EvalType;
  family: string;
  falsePositives: string[];
  falseNegatives: string[];
}

export interface ProofResults {
  schemaVersion: 1;
  corpusVersion: string;
  generatedAt: string;
  commit: string;
  /** package.json version the numbers were generated for — the public surfaces cite this, because a squash-merge erases branch commits. */
  version: string;
  method: { ci: 'wilson-95'; f1Ci: string; positiveClass: 'fail'; skipped: string };
  rules: Array<{
    name: string;
    category: EvalType;
    n: number;
    positives: number;
    negatives: number;
    skipped: number;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    ci95: RuleSummary['ci95'];
  }>;
  humanAgreement: { status: 'pending'; note: string };
}

/** Every registry rule, in bundle order, keyed by name. */
export function registryRules(): EvalRule[] {
  return (['completeness', 'relevance', 'safety', 'cost'] as const).flatMap((t) => rulesByType[t]);
}

/** Builds the EvalContext a case declares: text fields plus any extra context keys. */
export function contextFor(c: ReturnType<typeof materialiseCase>, fileConfig?: Record<string, unknown>): EvalContext {
  const ctx: EvalContext = { output: c.output };
  if (c.input !== undefined) ctx.input = c.input;
  if (c.expected !== undefined) ctx.expected = c.expected;
  if (fileConfig && Object.keys(fileConfig).length > 0) ctx.customConfig = { ...fileConfig };
  if (c.context) {
    const extra = c.context as Partial<EvalContext>;
    if (extra.costUsd !== undefined) ctx.costUsd = extra.costUsd;
    if (extra.tokenUsage !== undefined) ctx.tokenUsage = extra.tokenUsage;
    if (extra.toolCalls !== undefined) ctx.toolCalls = extra.toolCalls;
    if (extra.metadata !== undefined) ctx.metadata = extra.metadata;
    if (extra.customConfig !== undefined) ctx.customConfig = { ...(ctx.customConfig ?? {}), ...extra.customConfig };
  }
  return ctx;
}

/** Runs one family through its rule and returns the observations, one per case. */
export function observe(file: CorpusFile, rule: EvalRule): Observation[] {
  return file.cases.map((raw) => {
    const c = materialiseCase(raw);
    const result = rule.evaluate(contextFor(c, file.config));
    const skipped = result.skipped === true;
    return {
      id: c.id,
      actual: c.label === 'positive',
      predicted: !skipped && result.passed === false,
      skipped,
    };
  });
}

export async function measure(root: string): Promise<{ rows: RuleRow[]; corpusVersion: string; missing: string[] }> {
  const { files, corpusVersion } = await loadCorpus(root);
  const rules = registryRules();
  const registry = new Map(rules.map((r) => [r.name, r.evalType]));
  const byName = new Map(rules.map((r) => [r.name, r]));

  const issues = files.flatMap((f) => validateCorpusFile(f, `${f.family ?? '?'}.json`, registry));
  if (issues.length > 0) {
    throw new Error(`corpus validation failed:\n  ${issues.join('\n  ')}`);
  }
  const byRule = new Map(files.map((f) => [f.rule, f]));
  const dup = files.map((f) => f.rule).filter((r, i, a) => a.indexOf(r) !== i);
  if (dup.length > 0) throw new Error(`more than one family for: ${[...new Set(dup)].join(', ')}`);

  const rows: RuleRow[] = [];
  const missing: string[] = [];
  for (const rule of rules) {
    const file = byRule.get(rule.name);
    if (!file) {
      missing.push(rule.name);
      continue;
    }
    const obs = observe(file, byName.get(rule.name) as EvalRule);
    rows.push({
      name: rule.name,
      category: rule.evalType,
      family: file.family,
      ...summarise(obs),
      falsePositives: obs.filter((o) => !o.actual && o.predicted).map((o) => o.id),
      falseNegatives: obs.filter((o) => o.actual && !o.predicted).map((o) => o.id),
    });
  }
  return { rows, corpusVersion, missing };
}

function gitCommit(root: string): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export function toResults(rows: RuleRow[], corpusVersion: string, generatedAt: string, commit: string, version: string): ProofResults {
  return {
    schemaVersion: 1,
    corpusVersion,
    generatedAt,
    commit,
    version,
    method: {
      ci: 'wilson-95',
      f1Ci: F1_CI_METHOD,
      positiveClass: 'fail',
      skipped: 'a skipped result (the rule declined to judge) counts as not failed; the count is reported per rule',
    },
    rules: rows.map((r) => ({
      name: r.name,
      category: r.category,
      n: r.n,
      positives: r.positives,
      negatives: r.negatives,
      skipped: r.skipped,
      tp: r.tp,
      fp: r.fp,
      fn: r.fn,
      tn: r.tn,
      precision: r.precision,
      recall: r.recall,
      f1: r.f1,
      ci95: r.ci95,
    })),
    humanAgreement: {
      status: 'pending',
      note: 'founder blind label of a 40-case stratified sample; until then the labels are same-model dual annotation (see proof/README.md)',
    },
  };
}

/** JSON with every object's keys sorted, two-space indent, LF, trailing newline. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + '\n';
}

function pct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}

function ci(i: [number, number] | null): string {
  return i === null ? '—' : `[${(i[0] * 100).toFixed(1)}, ${(i[1] * 100).toFixed(1)}]`;
}

export function renderMarkdown(rows: RuleRow[], corpusVersion: string, generatedAt: string, commit: string, missing: string[], version: string): string {
  const L: string[] = [];
  L.push('# Iris built-in rules — measured on the proof corpus');
  L.push('');
  L.push(`Generated ${generatedAt} for v${version} (local generating commit \`${commit}\` — branch commits are squashed on merge, so cite the version).`);
  L.push(`Corpus version \`${corpusVersion}\` (sha256 of proof/corpus/*.json). Reproduce with \`npm run proof\`; CI runs \`npm run proof -- --check\`.`);
  L.push('');
  L.push('The positive class is the violation: precision = of the outputs the rule failed, the share that were real violations; recall = of the real violations, the share the rule failed. Intervals: Wilson 95% for precision and recall; a seeded percentile bootstrap for F1. A skipped result (the rule declined to judge) counts as not failed and is listed under "skip". Read proof/README.md before quoting a number — the corpus is synthetic, rule-aware, and labelled by the same model that wrote it.');
  L.push('');
  L.push('| Rule | Bundle | n | pos | skip | TP | FP | FN | TN | Precision (95% CI) | Recall (95% CI) | F1 (95% CI) |');
  L.push('|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|---|');
  for (const r of rows) {
    L.push(
      `| \`${r.name}\` | ${r.category} | ${r.n} | ${r.positives} | ${r.skipped} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${pct(r.precision)} ${ci(r.ci95.precision)} | ${pct(r.recall)} ${ci(r.ci95.recall)} | ${r.f1 === null ? '—' : r.f1.toFixed(3)} ${ci(r.ci95.f1)} |`,
    );
  }
  if (missing.length > 0) {
    L.push('');
    L.push(`> ⚠ Registry rules with no family yet (unmeasured): ${missing.map((m) => `\`${m}\``).join(', ')}.`);
  }
  L.push('');
  L.push('## Misses, by case id');
  L.push('');
  L.push('The ids the rule got wrong, so a reader can open the case and judge the miss for themselves. FP = a negative case the rule failed; FN = a positive case the rule passed or skipped.');
  L.push('');
  for (const r of rows) {
    const fp = r.falsePositives.length === 0 ? 'none' : r.falsePositives.join(', ');
    const fn = r.falseNegatives.length === 0 ? 'none' : r.falseNegatives.join(', ');
    L.push(`- \`${r.name}\` — FP: ${fp} · FN: ${fn}`);
  }
  L.push('');
  L.push('Human agreement: pending (founder blind label of a 40-case stratified sample).');
  L.push('');
  return L.join('\n');
}

/**
 * The generated module: one entry per measured rule, in registry order, plus
 * the provenance every number must travel with. `labelling` flips to
 * 'human-verified' when the founder's blind label lands (humanAgreement
 * status), and not before.
 */
export function renderPublishedAccuracy(results: ProofResults): string {
  const L: string[] = [];
  L.push('/*');
  L.push(' * GENERATED by `npm run proof` from proof/results.json — do not edit by hand.');
  L.push(' * `npm run proof -- --check` fails CI when this file differs from what the');
  L.push(' * runner produces. Read by src/eval/accuracy.ts; the numbers a verdict carries');
  L.push(' * are the numbers on https://iris-eval.com/proof, for the release named below.');
  L.push(' */');
  L.push('');
  L.push(`export const PUBLISHED_ACCURACY_CORPUS_VERSION = '${results.corpusVersion}';`);
  L.push(`export const PUBLISHED_ACCURACY_RELEASE = '${results.version}';`);
  L.push(`export const PUBLISHED_ACCURACY_LABELLING = '${results.humanAgreement.status === 'pending' ? 'same-model' : 'human-verified'}' as const;`);
  L.push('');
  L.push('export const PUBLISHED_ACCURACY = {');
  for (const r of results.rules) {
    const ci = (i: [number, number] | null): string => (i === null ? 'null' : `[${i[0]}, ${i[1]}]`);
    L.push(`  ${r.name}: {`);
    L.push(`    n: ${r.n}, tp: ${r.tp}, fp: ${r.fp}, fn: ${r.fn}, tn: ${r.tn},`);
    L.push(`    precision: ${r.precision}, recall: ${r.recall}, f1: ${r.f1},`);
    L.push(`    ci95: { precision: ${ci(r.ci95.precision)}, recall: ${ci(r.ci95.recall)}, f1: ${ci(r.ci95.f1)} },`);
    L.push('  },');
  }
  L.push('} as const;');
  L.push('');
  return L.join('\n');
}

/** Strips the two fields that legitimately change on every run/commit. */
export function normaliseForCheck(json: string, md: string): { json: string; md: string } {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  delete parsed.generatedAt;
  delete parsed.commit;
  return {
    json: stableJson(parsed),
    md: md.replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('Generated ')).join('\n'),
  };
}

/**
 * `--composite`: the verdict on the composite corpus (arc 2). Writes
 * proof/composite-results.json and proof/COMPOSITE.md, or with `--check`
 * regenerates them to a temp path and fails on any difference.
 */
async function composite(check: boolean): Promise<void> {
  const { results: partial, rows } = await measureComposite(repoRoot);
  const generatedAt = new Date().toISOString();
  const commit = gitCommit(repoRoot);
  const version = (JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;
  const results: CompositeResults = { ...partial, generatedAt, commit, version };
  const json = stableJson(results);
  const md = renderCompositeMarkdown(results);
  for (const [name, split] of [['test', 'test'], ['real', 'realTranscripts'], ['dev', 'dev']] as const) {
    process.stdout.write(`  ${name.padEnd(5)} legacy acc=${pct(results.legacy[split].accuracy.rate).padStart(6)} ${ci(results.legacy[split].accuracy.ci95).padEnd(14)} risk acc=${pct(results.risk[split].accuracy.rate).padStart(6)} ${ci(results.risk[split].accuracy.ci95).padEnd(14)} n=${results.legacy[split].accuracy.n}
`);
  }
  const d = results.difference.risk.test;
  const dc = results.difference.riskPerClass.test;
  process.stdout.write(`  difference (test): per-output ${d ? `${(d.delta * 100).toFixed(1)} points [${(d.lo * 100).toFixed(1)}, ${(d.hi * 100).toFixed(1)}]` : '—'}; per-class ${dc ? `${(dc.delta * 100).toFixed(1)} points [${(dc.lo * 100).toFixed(1)}, ${(dc.hi * 100).toFixed(1)}]` : '—'}; sweep argmax τ=${results.sweep.argmaxUtility} (shipped ${results.sweep.shippedTau}); cases=${rows.length}
`);
  if (check) {
    let committedJson = '';
    let committedMd = '';
    try {
      committedJson = await readFile(resolve(repoRoot, COMPOSITE_RESULTS_JSON), 'utf-8');
      committedMd = await readFile(resolve(repoRoot, COMPOSITE_MD), 'utf-8');
    } catch {
      process.stderr.write(`proof --check --composite — ${COMPOSITE_RESULTS_JSON} or ${COMPOSITE_MD} is missing; run npm run proof -- --composite and commit both.
`);
      process.exit(1);
    }
    const fresh = normaliseCompositeForCheck(json, md);
    const committed = normaliseCompositeForCheck(committedJson, committedMd);
    if (fresh.json === committed.json && fresh.md === committed.md) {
      process.stdout.write(`proof --check --composite — OK: ${COMPOSITE_RESULTS_JSON} and ${COMPOSITE_MD} match this code on composite ${results.compositeVersion}
`);
      return;
    }
    process.stderr.write(`proof --check --composite — FAIL: ${[fresh.json !== committed.json && COMPOSITE_RESULTS_JSON, fresh.md !== committed.md && COMPOSITE_MD].filter(Boolean).join(' and ')} differ from what this code produces. Run npm run proof -- --composite and commit the result.
`);
    process.exit(1);
  }
  await writeFile(resolve(repoRoot, COMPOSITE_RESULTS_JSON), json);
  await writeFile(resolve(repoRoot, COMPOSITE_MD), md);
  process.stdout.write(`proof — wrote ${COMPOSITE_RESULTS_JSON} and ${COMPOSITE_MD} (composite ${results.compositeVersion}, ${rows.length} cases)
`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const check = args.has('--check');
  if (args.has('--composite')) {
    await composite(check);
    return;
  }

  const { rows, corpusVersion, missing } = await measure(repoRoot);
  const generatedAt = new Date().toISOString();
  const commit = gitCommit(repoRoot);
  const version = (JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;
  const results = toResults(rows, corpusVersion, generatedAt, commit, version);
  const json = stableJson(results);
  const md = renderMarkdown(rows, corpusVersion, generatedAt, commit, missing, version);
  const ts = renderPublishedAccuracy(results);

  for (const r of rows) {
    process.stdout.write(
      `  ${r.name.padEnd(26)} n=${String(r.n).padStart(3)} skip=${String(r.skipped).padStart(2)} tp=${String(r.tp).padStart(3)} fp=${String(r.fp).padStart(3)} fn=${String(r.fn).padStart(3)} tn=${String(r.tn).padStart(3)}  P=${pct(r.precision).padStart(6)} ${ci(r.ci95.precision).padEnd(14)} R=${pct(r.recall).padStart(6)} ${ci(r.ci95.recall).padEnd(14)} F1=${r.f1 === null ? '—' : r.f1.toFixed(3)}\n`,
    );
  }
  if (missing.length > 0) {
    process.stderr.write(`proof — ${missing.length} registry rule(s) have no family: ${missing.join(', ')}\n`);
    if (check) {
      process.stderr.write('proof — every built-in rule must have a family; --check fails.\n');
      process.exit(1);
    }
  }

  if (check) {
    const dir = await mkdtemp(join(tmpdir(), 'iris-proof-'));
    try {
      await writeFile(join(dir, 'results.json'), json);
      await writeFile(join(dir, 'RESULTS.md'), md);
      const fresh = normaliseForCheck(await readFile(join(dir, 'results.json'), 'utf-8'), await readFile(join(dir, 'RESULTS.md'), 'utf-8'));
      let committedJson = '';
      let committedMd = '';
      try {
        committedJson = await readFile(resolve(repoRoot, RESULTS_JSON), 'utf-8');
        committedMd = await readFile(resolve(repoRoot, RESULTS_MD), 'utf-8');
      } catch {
        process.stderr.write(`proof --check — ${RESULTS_JSON} or ${RESULTS_MD} is missing; run npm run proof and commit both.\n`);
        process.exit(1);
      }
      const committed = normaliseForCheck(committedJson, committedMd);
      let committedTs = '';
      try {
        committedTs = (await readFile(resolve(repoRoot, PUBLISHED_ACCURACY_TS), 'utf-8')).replace(/\r\n/g, '\n');
      } catch {
        process.stderr.write(`proof --check — ${PUBLISHED_ACCURACY_TS} is missing; run npm run proof and commit it.\n`);
        process.exit(1);
      }
      const jsonSame = committed.json === fresh.json;
      const mdSame = committed.md === fresh.md;
      const tsSame = committedTs === ts;
      if (jsonSame && mdSame && tsSame) {
        process.stdout.write(`proof --check — OK: ${RESULTS_JSON}, ${RESULTS_MD} and ${PUBLISHED_ACCURACY_TS} match this code on corpus ${corpusVersion}\n`);
        return;
      }
      process.stderr.write(
        `proof --check — FAIL: ${[!jsonSame && RESULTS_JSON, !mdSame && RESULTS_MD, !tsSame && PUBLISHED_ACCURACY_TS].filter(Boolean).join(' and ')} differ from what this code produces. Run npm run proof and commit the result.\n`,
      );
      process.exit(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  await writeFile(resolve(repoRoot, RESULTS_JSON), json);
  await writeFile(resolve(repoRoot, RESULTS_MD), md);
  await writeFile(resolve(repoRoot, PUBLISHED_ACCURACY_TS), ts);
  process.stdout.write(`proof — wrote ${RESULTS_JSON}, ${RESULTS_MD} and ${PUBLISHED_ACCURACY_TS} (corpus ${corpusVersion}, ${rows.length} rules)\n`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`proof — fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
